/* ============================================================================
 * 2alm — build 0.2.0 — raw pencil capture base
 *
 * What this build does, and nothing more:
 *   - Records the pencil exactly as the screen reports each sample (no smoothing,
 *     no prediction, no curve fitting, no simplification).
 *   - Draws each sample where it lands. Pressure controls width only.
 *   - Ignores the palm while the pen is down and briefly after it lifts.
 *   - One finger scrolls the page.
 *   - Undo, clear page, reset zoom.
 *   - Saves the raw points to the .2alm file.
 *   - In-app updater (reads the main branch of your GitHub repo), debug log, self-tests.
 *
 * Single file, no dependencies, no build step.
 * ========================================================================== */
'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, TextFileView, Notice, Modal, requestUrl } = obsidian;

const BUILD_VERSION = '0.2.0';
const PLUGIN_ID = '2alm';
const VIEW_TYPE = '2alm-notebook-view';
const FILE_EXT = '2alm';
const FORMAT_VERSION = 1;
const NOTEBOOK_FOLDER = '2alm';
const PAGE_W = 1000;
const PAGE_H = 1400;
const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const MAX_HISTORY = 300;
const PAPER = '#fbfaf6';
const INK = '#1d1d1f';
const STROKE_BASE = 2.2; // page units; the pen's thickness before pressure
const PEN_CODE = 1;

const DEFAULT_SETTINGS = {
  updateBaseUrl: '',
  palmRejectMs: 900,
};

// ============================================================================
// Basics
// ============================================================================

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d) => {
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
};
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const DEBUG = { entries: [], max: 200 };
function logEvent(kind, msg) {
  DEBUG.entries.push(new Date().toISOString().slice(11, 19) + ' ' + kind + ' ' + msg);
  if (DEBUG.entries.length > DEBUG.max) DEBUG.entries.shift();
}

let idCounter = 0;
function newId() {
  idCounter = (idCounter + 1) % 1e9;
  return 's' + Date.now().toString(36) + idCounter.toString(36) + Math.random().toString(36).slice(2, 7);
}

// ============================================================================
// Raw stroke model
// ============================================================================

/** A stroke is just the samples as they arrived. Nothing is altered. */
function makeStroke(color, size, pts) {
  return { id: newId(), color, size, pts: pts || [] };
}

/** Records one sample exactly as given. */
function addRawPoint(stroke, x, y, pressure, t) {
  stroke.pts.push({ x, y, p: pressure, t });
  return stroke.pts[stroke.pts.length - 1];
}

function pressureOf(p) {
  return isNum(p) && p > 0 ? clamp(p, 0, 1) : 0.5; // 0 means the device gives no pressure
}

function widthFor(size, p) {
  return size * (0.4 + 0.9 * pressureOf(p));
}

function circlePts(cx, cy, r, steps) {
  const out = [];
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * Math.PI * 2;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Every polygon is wound the same way, so overlapping pieces union cleanly under nonzero fill. */
function ccw(poly) {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

/** The quad between two raw samples, with each end as wide as its own pressure. */
function segmentPoly(a, b, size) {
  const wa = widthFor(size, a.p) / 2;
  const wb = widthFor(size, b.p) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const nx = -dy / len;
  const ny = dx / len;
  return ccw([
    { x: a.x + nx * wa, y: a.y + ny * wa },
    { x: b.x + nx * wb, y: b.y + ny * wb },
    { x: b.x - nx * wb, y: b.y - ny * wb },
    { x: a.x - nx * wa, y: a.y - ny * wa },
  ]);
}

/** A round dot at one raw sample. Gives round ends and joins. */
function dotPoly(q, size) {
  return ccw(circlePts(q.x, q.y, widthFor(size, q.p) / 2, 12));
}

/** All pieces for a whole stroke: one dot per sample plus one quad per gap between samples. */
function strokePolys(stroke) {
  const out = [];
  const pts = stroke.pts;
  for (let i = 0; i < pts.length; i++) {
    out.push(dotPoly(pts[i], stroke.size));
    if (i > 0) {
      const s = segmentPoly(pts[i - 1], pts[i], stroke.size);
      if (s) out.push(s);
    }
  }
  return out;
}

function polysToPath(polys) {
  const p = new Path2D();
  for (const poly of polys) {
    if (!poly || poly.length === 0) continue;
    p.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) p.lineTo(poly[i].x, poly[i].y);
    p.closePath();
  }
  return p;
}

// ============================================================================
// History, viewport, palm rejection
// ============================================================================

/** Undo and redo over immutable snapshots of the stroke list. */
class History {
  constructor(present) {
    this.present = present;
    this.past = [];
    this.future = [];
  }
  commit(base, next) {
    if (base === next) return false;
    this.past.push(base);
    if (this.past.length > MAX_HISTORY) this.past.shift();
    this.present = next;
    this.future = [];
    return true;
  }
  undo() {
    if (!this.past.length) return false;
    this.future.push(this.present);
    this.present = this.past.pop();
    return true;
  }
  redo() {
    if (!this.future.length) return false;
    this.past.push(this.present);
    this.present = this.future.pop();
    return true;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}

/** Pan and zoom. screen = page * scale + translate. */
class Viewport {
  constructor() {
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
  }
  toPage(sx, sy) {
    return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale };
  }
  toScreen(x, y) {
    return { x: x * this.scale + this.tx, y: y * this.scale + this.ty };
  }
  panBy(dx, dy) {
    this.tx += dx;
    this.ty += dy;
  }
  zoomAt(sx, sy, factor) {
    const ns = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    const f = ns / this.scale;
    this.tx = sx - (sx - this.tx) * f;
    this.ty = sy - (sy - this.ty) * f;
    this.scale = ns;
  }
}

/**
 * Pens and mouse draw. Fingers scroll, unless a pen is on the glass or lifted very recently,
 * in which case the finger is treated as the palm and ignored.
 */
class InputRouter {
  constructor(palmMs) {
    this.palmMs = palmMs;
    this.penIds = new Set();
    this.lastPenUp = -Infinity;
  }
  down(id, type) {
    if (type === 'pen') this.penIds.add(id);
  }
  up(id, type, t) {
    if (type === 'pen') {
      this.penIds.delete(id);
      this.lastPenUp = t;
    }
  }
  decide(type, t) {
    if (type === 'pen' || type === 'mouse') return 'draw';
    if (type === 'touch') {
      if (this.penIds.size > 0 || t - this.lastPenUp < this.palmMs) return 'ignore';
      return 'pan';
    }
    return 'ignore';
  }
}

// ============================================================================
// File format: raw points, one page of strokes, extra pages preserved
// ============================================================================

/**
 * Format v1. Coordinates are stored to 0.01 page units, pressure to 0.001, time as
 * milliseconds relative to the stroke's first sample. Nothing is smoothed or dropped.
 */
function serializeNotebook(pages) {
  return JSON.stringify({
    format: '2alm',
    v: FORMAT_VERSION,
    pages: pages.map((pg) => ({
      template: 'blank',
      strokes: pg.strokes.map((s) => {
        const t0 = s.pts.length ? s.pts[0].t : 0;
        const flat = [];
        for (const q of s.pts) {
          // Never round a real pressure down to 0: 0 means "no pressure data" on reload.
          const pq = Math.max(0.001, round(pressureOf(q.p), 3));
          flat.push(round(q.x, 2), round(q.y, 2), pq, Math.round(q.t - t0));
        }
        return { id: s.id, t: PEN_CODE, c: s.color, s: round(s.size, 2), p: flat };
      }),
    })),
  });
}

function newNotebookText() {
  return serializeNotebook([{ strokes: [] }]);
}

/** Reads v1 files. Older 0.1.x files with pencil/highlighter codes are read as ink. */
function parseNotebook(text) {
  if (typeof text !== 'string' || !text.trim()) return { pages: [{ strokes: [] }] };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error('file is not valid JSON');
  }
  if (!obj || obj.format !== '2alm') throw new Error('not a 2alm notebook');
  if (!isNum(obj.v) || obj.v < 1 || obj.v > FORMAT_VERSION) {
    throw new Error(`unsupported format version ${obj.v} (this build reads up to ${FORMAT_VERSION})`);
  }
  if (!Array.isArray(obj.pages)) throw new Error('missing pages list');

  const pages = obj.pages.map((pg) => {
    if (!pg || typeof pg !== 'object') throw new Error('malformed page');
    const list = pg.strokes === undefined ? [] : pg.strokes;
    if (!Array.isArray(list)) throw new Error('malformed strokes list');
    const strokes = list.map((s) => {
      if (!s || !(s.t === 1 || s.t === 2 || s.t === 3)) throw new Error('unknown tool code');
      if (!Array.isArray(s.p) || s.p.length % 4 !== 0 || !s.p.every(isNum)) throw new Error('malformed point data');
      if (!isNum(s.s) || s.s <= 0 || s.s > 500) throw new Error('invalid stroke size');
      const pts = [];
      for (let k = 0; k < s.p.length; k += 4) {
        pts.push({ x: s.p[k], y: s.p[k + 1], p: clamp(s.p[k + 2], 0, 1), t: s.p[k + 3] });
      }
      return {
        id: typeof s.id === 'string' ? s.id : newId(),
        color: /^#[0-9a-fA-F]{6}$/.test(s.c) ? s.c : INK,
        size: s.s,
        pts,
      };
    });
    return { strokes };
  });
  if (!pages.length) pages.push({ strokes: [] });
  return { pages };
}

/**
 * Obsidian may hand us file contents after we saved. Only accept them if they differ from our
 * own last save and we have no unsaved edits, so in-progress strokes are never overwritten.
 */
function acceptExternalData(lastSaved, incoming, dirty) {
  if (dirty) return false;
  return incoming !== lastSaved;
}

// ============================================================================
// Updater (reads the main branch of your repo, so no releases are needed)
// ============================================================================

function normalizeBase(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/\s]+/.test(u)) throw new Error('the update URL must start with https://');
  return u;
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function validateRemoteManifest(m) {
  if (!m || m.id !== PLUGIN_ID) throw new Error('the remote manifest is not for 2alm');
  if (typeof m.version !== 'string' || !/^\d+(\.\d+)*$/.test(m.version)) {
    throw new Error('the remote manifest has no valid version');
  }
}

/** Checks the downloaded main.js really is the advertised build and that it compiles. */
function verifyMainJs(js, version) {
  const m = /const BUILD_VERSION = '([^']+)';/.exec(js);
  if (!m) throw new Error('downloaded main.js is not a 2alm build');
  if (m[1] !== version) throw new Error(`downloaded main.js is ${m[1]}, expected ${version}`);
  try {
    new Function(js); // compile only, never executed
  } catch (e) {
    throw new Error('downloaded main.js has a syntax error: ' + e.message);
  }
}

async function fetchUpdateInfo(baseUrl, get) {
  const base = normalizeBase(baseUrl);
  let remote;
  try {
    remote = JSON.parse(await get(`${base}/manifest.json`));
  } catch (e) {
    throw new Error('could not read manifest.json: ' + e.message);
  }
  validateRemoteManifest(remote);
  return { base, remote };
}

async function downloadRelease(base, version, get) {
  const js = await get(`${base}/main.js`);
  let css = '';
  try {
    css = await get(`${base}/styles.css`);
  } catch (e) {
    css = ''; // styles.css is optional
  }
  verifyMainJs(js, version);
  return { js, css };
}

async function readOrNull(adapter, path) {
  return (await adapter.exists(path)) ? adapter.read(path) : null;
}

/** Writes the release into the plugin folder. Keeps main.js.bak and restores on failure. */
async function writeRelease(adapter, dir, remote, rel) {
  const p = { js: `${dir}/main.js`, css: `${dir}/styles.css`, mf: `${dir}/manifest.json` };
  const old = {
    js: await readOrNull(adapter, p.js),
    css: await readOrNull(adapter, p.css),
    mf: await readOrNull(adapter, p.mf),
  };
  try {
    if (old.js !== null) await adapter.write(`${p.js}.bak`, old.js);
    await adapter.write(p.js, rel.js);
    if (rel.css) await adapter.write(p.css, rel.css);
    await adapter.write(p.mf, JSON.stringify(remote, null, 2));
  } catch (e) {
    for (const [key, path] of [['js', p.js], ['css', p.css], ['mf', p.mf]]) {
      if (old[key] !== null) await adapter.write(path, old[key]).catch(() => {});
    }
    throw new Error('could not write the update, previous version restored: ' + e.message);
  }
}

async function httpGet(url) {
  const bust = url + (url.includes('?') ? '&' : '?') + 'nocache=' + Date.now();
  const r = await requestUrl({ url: bust, throw: false });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text;
}

// ============================================================================
// The notebook view
// ============================================================================

class NotebookView extends TextFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.hist = new History([]);
    this.extraPages = [];     // pages beyond the first are kept untouched
    this.rawData = '';
    this.loadError = null;
    this.vp = new Viewport();
    this.viewReady = false;
    this.router = new InputRouter(plugin.settings.palmRejectMs);
    this.live = null;         // the stroke being written right now
    this.touches = new Map(); // finger pointerId -> last screen position
    this.pathCache = new WeakMap();
    this.raf = 0;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
    this.ro = null;
    this.lastSaved = null;
    this.dirty = false;
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return this.file ? this.file.basename : '2alm notebook';
  }
  getIcon() {
    return 'pen-tool';
  }
  canAcceptExtension(ext) {
    return ext === FILE_EXT;
  }

  requestSave() {
    this.dirty = true;
    super.requestSave();
  }

  getViewData() {
    if (this.loadError) return this.rawData; // never overwrite a file we could not read
    const text = serializeNotebook([{ strokes: this.hist.present }, ...this.extraPages]);
    this.lastSaved = text;
    this.dirty = false;
    return text;
  }

  setViewData(data) {
    if (!acceptExternalData(this.lastSaved, data, this.dirty)) {
      this.ensureDom();
      this.refresh();
      return;
    }
    this.rawData = data;
    this.loadError = null;
    this.live = null;
    this.touches.clear();
    try {
      const nb = parseNotebook(data);
      this.hist = new History(nb.pages[0].strokes);
      this.extraPages = nb.pages.slice(1);
    } catch (e) {
      this.loadError = e.message;
      this.hist = new History([]);
      this.extraPages = [];
      new Notice('2alm: this notebook could not be read — ' + e.message, 9000);
    }
    this.ensureDom();
    if (!this.viewReady) this.resetView();
    this.refresh();
    this.schedule();
  }

  clear() {
    this.hist = new History([]);
    this.live = null;
    this.schedule();
  }

  async onOpen() {
    this.ensureDom();
  }

  async onClose() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.ro) this.ro.disconnect();
    this.ro = null;
  }

  // ---- DOM ----

  ensureDom() {
    if (this.canvas) return;
    const root = this.contentEl;
    root.empty();
    root.addClass('twoalm-root');

    const toolbar = root.createDiv({ cls: 'twoalm-toolbar' });
    const button = (text, title, onClick) => {
      const b = toolbar.createEl('button', { cls: 'twoalm-btn', text, attr: { title, 'aria-label': title } });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      return b;
    };
    this.btnUndo = button('Undo', 'Undo the last stroke', () => this.undo());
    this.btnClear = button('Clear page', 'Clear this page (you can undo it)', () => this.clearPage());
    button('Reset zoom', 'Return to the default view', () => {
      this.resetView();
      this.schedule();
    });
    this.status = toolbar.createDiv({ cls: 'twoalm-status' });

    this.stage = root.createDiv({ cls: 'twoalm-stage' });
    this.canvas = this.stage.createEl('canvas', { cls: 'twoalm-canvas' });
    this.ctx = this.canvas.getContext('2d');

    const safe = (name, fn) => (e) => {
      const t0 = now();
      try {
        fn(e);
      } catch (err) {
        logEvent('error', name + ': ' + (err && err.message ? err.message : err));
        this.live = null;
        this.touches.clear();
        this.schedule();
      }
      const ms = now() - t0;
      if (ms > 25) logEvent('slow', `${name} took ${ms.toFixed(0)} ms`);
    };
    this.canvas.addEventListener('pointerdown', safe('down', (e) => this.onPointerDown(e)));
    this.canvas.addEventListener('pointermove', safe('move', (e) => this.onPointerMove(e)));
    this.canvas.addEventListener('pointerup', safe('up', (e) => this.onPointerUp(e)));
    this.canvas.addEventListener('pointercancel', safe('cancel', (e) => this.onPointerUp(e)));
    this.canvas.addEventListener('lostpointercapture', safe('lost', (e) => this.onPointerUp(e)));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.stage);
    }
    this.resize();
    this.refresh();
  }

  refresh() {
    if (!this.btnUndo) return;
    this.btnUndo.disabled = !this.hist.canUndo;
    const n = this.hist.present.length;
    this.status.setText(this.loadError ? 'read error' : `${n} stroke${n === 1 ? '' : 's'}`);
  }

  // ---- layout ----

  resize() {
    if (!this.stage || !this.canvas) return;
    const r = this.stage.getBoundingClientRect();
    this.cssW = r.width;
    this.cssH = r.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    if (!this.viewReady && r.width > 0) this.resetView();
    this.schedule();
  }

  resetView() {
    if (this.cssW <= 0) return;
    const s = clamp(Math.min((this.cssW - 40) / PAGE_W, (this.cssH - 80) / PAGE_H), MIN_SCALE, MAX_SCALE);
    this.vp.scale = s;
    this.vp.tx = (this.cssW - PAGE_W * s) / 2;
    this.vp.ty = 56;
    this.viewReady = true;
  }

  toPage(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.vp.toPage(e.clientX - r.left, e.clientY - r.top);
  }

  // ---- commands ----

  undo() {
    if (this.loadError) return;
    if (this.hist.undo()) {
      this.refresh();
      this.schedule();
      this.requestSave();
    }
  }

  clearPage() {
    if (this.loadError || !this.hist.present.length) return;
    this.hist.commit(this.hist.present, []);
    this.refresh();
    this.schedule();
    this.requestSave();
  }

  // ---- pointer input ----

  onPointerDown(e) {
    if (this.loadError) return;
    this.router.down(e.pointerId, e.pointerType);
    const decision = this.router.decide(e.pointerType, e.timeStamp);
    if (decision === 'draw') {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.pointerType === 'pen') this.touches.clear(); // a pen cancels any finger scroll
      this.canvas.setPointerCapture(e.pointerId);
      if (this.live) this.finishLive(); // never discard a stroke that is still open
      this.live = makeStroke(INK, STROKE_BASE, []);
      this.live.owner = e.pointerId; // bookkeeping only; not saved
      const pt = this.toPage(e);
      addRawPoint(this.live, pt.x, pt.y, e.pressure, e.timeStamp);
      this.drawPiece(this.live, 0);
    } else if (decision === 'pan') {
      this.canvas.setPointerCapture(e.pointerId);
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
  }

  onPointerMove(e) {
    if (this.live && e.pointerId === this.live.owner) {
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ev of list.length ? list : [e]) {
        const pt = this.toPage(ev);
        const idx = this.live.pts.length;
        addRawPoint(this.live, pt.x, pt.y, ev.pressure, ev.timeStamp);
        this.drawPiece(this.live, idx);
      }
      return;
    }
    if (this.touches.has(e.pointerId)) {
      const prev = this.touches.get(e.pointerId);
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 1) {
        this.vp.panBy(e.clientX - prev.x, e.clientY - prev.y);
        this.schedule();
      }
    }
  }

  onPointerUp(e) {
    this.router.up(e.pointerId, e.pointerType, e.timeStamp);
    if (this.live && e.pointerId === this.live.owner) {
      this.finishLive();
    } else if (this.touches.has(e.pointerId)) {
      this.touches.delete(e.pointerId);
    }
  }

  finishLive() {
    const s = this.live;
    this.live = null;
    if (!s || s.pts.length === 0) return;
    this.hist.commit(this.hist.present, [...this.hist.present, s]);
    this.refresh();
    this.requestSave();
  }

  onWheel(e) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) this.vp.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
    else this.vp.panBy(-e.deltaX, -e.deltaY);
    this.schedule();
  }

  // ---- rendering ----

  /** Draws just the newest sample and its join onto the canvas, right away, with no frame delay. */
  drawPiece(stroke, idx) {
    const ctx = this.ctx;
    const vp = this.vp;
    ctx.setTransform(this.dpr * vp.scale, 0, 0, this.dpr * vp.scale, this.dpr * vp.tx, this.dpr * vp.ty);
    ctx.fillStyle = stroke.color;
    const polys = [dotPoly(stroke.pts[idx], stroke.size)];
    if (idx > 0) {
      const s = segmentPoly(stroke.pts[idx - 1], stroke.pts[idx], stroke.size);
      if (s) polys.push(s);
    }
    ctx.fill(polysToPath(polys));
  }

  /** Full repaint from the stored raw strokes. Used after scrolling, zooming, undo, and resize. */
  schedule() {
    if (this.raf || !this.canvas) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  pathOf(stroke) {
    let p = this.pathCache.get(stroke);
    if (!p) {
      p = polysToPath(strokePolys(stroke));
      this.pathCache.set(stroke, p);
    }
    return p;
  }

  paint() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = document.body.classList.contains('theme-dark') ? '#1e1e1e' : '#e7e5df';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const vp = this.vp;
    const dpr = this.dpr;
    ctx.setTransform(dpr * vp.scale, 0, 0, dpr * vp.scale, dpr * vp.tx, dpr * vp.ty);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    for (const s of this.hist.present) {
      ctx.fillStyle = s.color;
      ctx.fill(this.pathOf(s));
    }
    if (this.live) {
      ctx.fillStyle = this.live.color;
      ctx.fill(polysToPath(strokePolys(this.live)));
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

// ============================================================================
// Built-in self-tests (run in-app from settings or the command palette)
// ============================================================================

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertClose(a, b, eps, msg) {
  assert(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);
}
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

const SELF_TESTS = [
  // --- raw capture: the core promise of this build
  {
    name: 'Raw: every sample is stored exactly as given (no smoothing)',
    run() {
      const s = makeStroke(INK, 2, []);
      const input = [
        [10.123, 20.456, 0.37, 1000],
        [11.9, 19.2, 0.81, 1008],
        [14.2, 18.0, 0.02, 1017],
      ];
      for (const [x, y, p, t] of input) addRawPoint(s, x, y, p, t);
      assert(s.pts.length === 3, 'sample count changed');
      s.pts.forEach((q, i) => {
        assert(q.x === input[i][0] && q.y === input[i][1], `sample ${i} moved`);
        assert(q.p === input[i][2] && q.t === input[i][3], `sample ${i} altered`);
      });
    },
  },
  {
    name: 'Raw: a straight pen movement stays perfectly straight in the drawn shape',
    run() {
      const s = makeStroke(INK, 2, []);
      for (let i = 0; i <= 10; i++) addRawPoint(s, i * 10, 50, 0.5, i);
      // Every drawn piece must sit within the stroke's half-width of the line y = 50.
      const halfW = widthFor(2, 0.5) / 2 + 1e-9;
      for (const poly of strokePolys(s)) {
        for (const q of poly) assertClose(q.y, 50, halfW, 'a piece bent away from the line');
      }
    },
  },
  {
    name: 'Raw: every drawn piece is wound the same way (overlaps union cleanly)',
    run() {
      const rnd = seededRandom(4);
      const s = makeStroke(INK, 3, []);
      for (let i = 0; i < 60; i++) addRawPoint(s, rnd() * 900, rnd() * 1300, rnd(), i);
      for (const poly of strokePolys(s)) assert(signedArea(poly) >= 0, 'a piece has the wrong winding');
    },
  },
  {
    name: 'Raw: every sample lies inside its own round dot',
    run() {
      const s = makeStroke(INK, 2, []);
      addRawPoint(s, 300.5, 400.25, 0.6, 0);
      addRawPoint(s, 301.5, 402.0, 0.2, 9);
      s.pts.forEach((q, i) => assert(pointInPoly(q, dotPoly(q, s.size)), `sample ${i} outside its dot`));
    },
  },
  {
    name: 'Pressure: heavier pressure draws a thicker line; no pressure data uses a middle width',
    run() {
      assert(widthFor(2, 1) > widthFor(2, 0.2), 'pressure has no effect');
      assertClose(widthFor(2, 0), widthFor(2, 0.5), 1e-9, 'missing pressure');
      for (const p of [-1, 0, 0.5, 1, 3, NaN, undefined]) {
        const w = widthFor(2, p);
        assert(Number.isFinite(w) && w > 0, `width for ${p} is ${w}`);
      }
    },
  },

  // --- palm rejection and scrolling
  {
    name: 'Palm: the pen and mouse draw',
    run() {
      const r = new InputRouter(900);
      assert(r.decide('pen', 0) === 'draw', 'pen');
      assert(r.decide('mouse', 0) === 'draw', 'mouse');
    },
  },
  {
    name: 'Palm: fingers are ignored while the pen is down',
    run() {
      const r = new InputRouter(900);
      r.down(1, 'pen');
      assert(r.decide('touch', 10) === 'ignore', 'finger accepted during pen contact');
      r.up(1, 'pen', 50);
    },
  },
  {
    name: 'Palm: fingers are ignored briefly after the pen lifts, then scroll',
    run() {
      const r = new InputRouter(900);
      r.down(1, 'pen');
      r.up(1, 'pen', 100);
      assert(r.decide('touch', 500) === 'ignore', 'inside the palm window');
      assert(r.decide('touch', 1200) === 'pan', 'after the palm window');
    },
  },
  {
    name: 'Scroll: a finger scrolls when no pen has been used',
    run() {
      assert(new InputRouter(900).decide('touch', 5000) === 'pan', 'finger did not scroll');
    },
  },
  {
    name: 'View: screen and page coordinates convert both ways after scroll and zoom',
    run() {
      const v = new Viewport();
      v.scale = 2.5;
      v.tx = 13;
      v.ty = -7;
      const s = v.toScreen(123.4, 567.8);
      const p = v.toPage(s.x, s.y);
      assertClose(p.x, 123.4, 1e-9, 'x');
      assertClose(p.y, 567.8, 1e-9, 'y');
    },
  },
  {
    name: 'View: zooming keeps the point under the cursor in place',
    run() {
      const v = new Viewport();
      const before = v.toPage(200, 300);
      v.zoomAt(200, 300, 1.7);
      const after = v.toScreen(before.x, before.y);
      assertClose(after.x, 200, 1e-9, 'x');
      assertClose(after.y, 300, 1e-9, 'y');
    },
  },

  // --- undo, file format, safety
  {
    name: 'Undo: undo and redo walk the stroke list; a new stroke clears redo',
    run() {
      const h = new History([]);
      const a = [1];
      const b = [1, 2];
      h.commit(h.present, a);
      h.commit(h.present, b);
      assert(h.undo() && h.present === a, 'undo 1');
      assert(h.undo() && h.present.length === 0, 'undo 2');
      assert(!h.undo(), 'undo past the start');
      assert(h.redo() && h.present === a, 'redo');
      h.commit(h.present, [9]);
      assert(!h.redo(), 'redo should be cleared');
    },
  },
  {
    name: 'File: raw samples survive a save and reload (to 0.01 page units)',
    run() {
      const s = makeStroke('#0a84ff', 2.5, [
        { x: 10.12, y: 20.34, p: 0.7, t: 1000 },
        { x: 30.56, y: 40.78, p: 0.2, t: 1016 },
      ]);
      const got = parseNotebook(serializeNotebook([{ strokes: [s] }])).pages[0].strokes[0];
      assertClose(got.pts[0].x, 10.12, 1e-9, 'x0');
      assertClose(got.pts[1].y, 40.78, 1e-9, 'y1');
      assertClose(got.pts[0].p, 0.7, 1e-9, 'pressure');
      assert(got.pts[1].t === 16, 'times are relative to the stroke start');
      assert(got.color === '#0a84ff' && got.size === 2.5, 'colour or size lost');
    },
  },
  {
    name: 'File: a save, reload, save cycle is stable',
    run() {
      const s = makeStroke(INK, 2, [
        { x: 100, y: 100, p: 0.5, t: 0 },
        { x: 120.5, y: 130.25, p: 0.8, t: 10 },
      ]);
      const once = serializeNotebook([{ strokes: [s] }]);
      const twice = serializeNotebook(parseNotebook(once).pages);
      assert(twice === once, 'the file changed on the second save');
    },
  },
  {
    name: 'File: older 0.1.x files still open (pencil and highlighter read as ink)',
    run() {
      const old = JSON.stringify({
        format: '2alm', v: 1,
        pages: [{ template: 'lined', strokes: [{ id: 'a', t: 3, c: '#ffd60a', s: 4, p: [1, 2, 0.5, 0, 9, 9, 0.5, 8] }] }],
      });
      const st = parseNotebook(old).pages[0].strokes[0];
      assert(st.pts.length === 2 && st.color === '#ffd60a', 'old file did not load');
    },
  },
  {
    name: 'File: foreign, future and malformed files are refused',
    run() {
      const bad = [
        'not json',
        '{"format":"other","v":1,"pages":[]}',
        '{"format":"2alm","v":99,"pages":[]}',
        '{"format":"2alm","v":1,"pages":[{"strokes":[{"t":9,"s":1,"p":[1,2,3,4]}]}]}',
        '{"format":"2alm","v":1,"pages":[{"strokes":[{"t":1,"s":1,"p":[1,2,3]}]}]}',
        '{"format":"2alm","v":1,"pages":[{"strokes":[{"t":1,"s":-4,"p":[1,2,3,4]}]}]}',
      ];
      for (const text of bad) {
        let threw = false;
        try {
          parseNotebook(text);
        } catch (e) {
          threw = true;
        }
        assert(threw, 'accepted a bad file: ' + text);
      }
    },
  },
  {
    name: 'File: extra pages are kept, not dropped',
    run() {
      const text = JSON.stringify({
        format: '2alm', v: 1,
        pages: [{ strokes: [] }, { strokes: [{ id: 'k', t: 1, c: '#000000', s: 2, p: [5, 5, 0.5, 0] }] }],
      });
      const nb = parseNotebook(text);
      assert(nb.pages.length === 2 && nb.pages[1].strokes.length === 1, 'second page lost');
    },
  },
  {
    name: 'Safety: external contents are ignored while there are unsaved edits',
    run() {
      assert(acceptExternalData('saved-a', 'other', true) === false, 'overwrote unsaved work');
    },
  },
  {
    name: 'Safety: our own last save is not reloaded over the live state',
    run() {
      assert(acceptExternalData('saved-a', 'saved-a', false) === false, 'reloaded our own save');
    },
  },
  {
    name: 'Safety: genuinely new external contents are accepted when clean',
    run() {
      assert(acceptExternalData('saved-a', 'edited-elsewhere', false) === true, 'refused a real change');
      assert(acceptExternalData(null, 'first load', false) === true, 'refused the first load');
    },
  },

  // --- updater
  {
    name: 'Updates: versions compare numerically (0.10.0 is newer than 0.9.0)',
    run() {
      assert(compareVersions('0.10.0', '0.9.0') > 0, '0.10.0 vs 0.9.0');
      assert(compareVersions('1.0', '1.0.0') === 0, '1.0 vs 1.0.0');
      assert(compareVersions('0.1.0', '0.1.1') < 0, '0.1.0 vs 0.1.1');
    },
  },
  {
    name: 'Updates: only https addresses are accepted',
    run() {
      assert(normalizeBase('https://example.com/a/') === 'https://example.com/a', 'trailing slash');
      for (const bad of ['', 'http://example.com', 'ftp://x', 'example.com']) {
        let threw = false;
        try {
          normalizeBase(bad);
        } catch (e) {
          threw = true;
        }
        assert(threw, 'accepted ' + bad);
      }
    },
  },
  {
    name: 'Updates: a downloaded main.js must match its version and compile',
    run() {
      verifyMainJs("const BUILD_VERSION = '0.2.0';\nmodule.exports = {};", '0.2.0');
      let rejected = 0;
      for (const [js, v] of [
        ["const BUILD_VERSION = '0.2.0';", '0.3.0'],
        ['module.exports = {};', '0.2.0'],
        ["const BUILD_VERSION = '0.2.0'; function (", '0.2.0'],
      ]) {
        try {
          verifyMainJs(js, v);
        } catch (e) {
          rejected++;
        }
      }
      assert(rejected === 3, `only ${rejected} of 3 bad builds were rejected`);
    },
  },

  // --- diagnostics and budgets
  {
    name: 'Diagnostics: the event log keeps only the newest 200 entries',
    run() {
      const before = DEBUG.entries.length;
      for (let i = 0; i < 250; i++) logEvent('test', 'entry ' + i);
      assert(DEBUG.entries.length === DEBUG.max, `length ${DEBUG.entries.length}`);
      assert(DEBUG.entries[DEBUG.entries.length - 1].endsWith('entry 249'), 'newest entry missing');
      DEBUG.entries.length = Math.min(before, DEBUG.max);
    },
  },
  {
    name: 'Budget: saving 2000 strokes of 40 samples takes under 500 ms',
    run() {
      const strokes = [];
      for (let i = 0; i < 2000; i++) {
        const s = makeStroke(INK, 2, []);
        for (let k = 0; k < 40; k++) addRawPoint(s, k * 2 + i * 0.1, i * 0.5, 0.5, k * 8);
        strokes.push(s);
      }
      const t0 = now();
      const text = serializeNotebook([{ strokes }]);
      const ms = now() - t0;
      assert(ms < 500, `took ${ms.toFixed(1)} ms`);
      assert(parseNotebook(text).pages[0].strokes.length === 2000, 'lost strokes');
    },
  },
  {
    name: 'Ids: 10000 generated ids are unique',
    run() {
      const set = new Set();
      for (let i = 0; i < 10000; i++) set.add(newId());
      assert(set.size === 10000, 'duplicate ids');
    },
  },
];

function runSelfTests(list = SELF_TESTS) {
  return list.map((t) => {
    const t0 = now();
    try {
      t.run();
      return { name: t.name, ok: true, ms: now() - t0, error: '' };
    } catch (e) {
      return { name: t.name, ok: false, ms: now() - t0, error: e && e.message ? e.message : String(e) };
    }
  });
}

class SelfTestModal extends Modal {
  constructor(app, results) {
    super(app);
    this.results = results;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const passed = this.results.filter((r) => r.ok).length;
    contentEl.createEl('h2', { text: `2alm self-tests: ${passed} / ${this.results.length} passed` });
    const list = contentEl.createEl('ul');
    for (const r of this.results) {
      list.createEl('li', { text: `${r.ok ? '✓' : '✗'} ${r.name} (${r.ms.toFixed(1)} ms)${r.ok ? '' : ' — ' + r.error}` });
    }
  }
  onClose() {
    this.contentEl.empty();
  }
}

class DebugLogModal extends Modal {
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '2alm debug log' });
    const box = contentEl.createEl('textarea', { attr: { readonly: 'true', rows: '16' } });
    box.style.width = '100%';
    box.style.fontFamily = 'var(--font-monospace)';
    box.value = DEBUG.entries.length ? DEBUG.entries.join('\n') : '(no events recorded this session)';
    contentEl.createEl('button', { text: 'Select all' }).addEventListener('click', () => box.select());
  }
  onClose() {
    this.contentEl.empty();
  }
}

// ============================================================================
// Plugin class and settings
// ============================================================================

class TwoAlmPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new NotebookView(leaf, this));
    this.registerExtensions([FILE_EXT], VIEW_TYPE);
    this.registerDomEvent(window, 'error', (e) => logEvent('error', `${e.message} (line ${e.lineno})`));
    this.registerDomEvent(window, 'unhandledrejection', (e) =>
      logEvent('error', 'promise: ' + (e.reason && e.reason.message ? e.reason.message : e.reason))
    );

    this.addRibbonIcon('pen-tool', '2alm: new notebook', () => this.createNotebook());
    this.addCommand({ id: 'new-notebook', name: 'New notebook', callback: () => this.createNotebook() });
    this.addCommand({
      id: 'check-for-updates',
      name: 'Check for 2alm updates and install',
      callback: () => this.checkForUpdates({ install: true }),
    });
    this.addCommand({ id: 'show-debug-log', name: 'Show 2alm debug log', callback: () => new DebugLogModal(this.app).open() });
    this.addCommand({ id: 'run-self-tests', name: 'Run 2alm self-tests', callback: () => this.showSelfTests() });
    this.addSettingTab(new TwoAlmSettingTab(this.app, this));
    console.log(`2alm ${BUILD_VERSION} loaded`);
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async createNotebook() {
    try {
      const vault = this.app.vault;
      if (!vault.getAbstractFileByPath(NOTEBOOK_FOLDER)) await vault.createFolder(NOTEBOOK_FOLDER);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      let path = `${NOTEBOOK_FOLDER}/Notebook ${stamp}.${FILE_EXT}`;
      let n = 2;
      while (vault.getAbstractFileByPath(path)) path = `${NOTEBOOK_FOLDER}/Notebook ${stamp} ${n++}.${FILE_EXT}`;
      const file = await vault.create(path, newNotebookText());
      await this.app.workspace.getLeaf(true).openFile(file);
    } catch (e) {
      new Notice('2alm: could not create notebook — ' + e.message, 8000);
    }
  }

  showSelfTests() {
    new SelfTestModal(this.app, runSelfTests()).open();
  }

  /** Reads the main branch of the repo and installs a newer build when there is one. */
  async checkForUpdates({ install = false } = {}) {
    let info;
    try {
      info = await fetchUpdateInfo(this.settings.updateBaseUrl, httpGet);
    } catch (e) {
      new Notice('2alm update: ' + e.message, 8000);
      return;
    }
    if (compareVersions(info.remote.version, BUILD_VERSION) <= 0) {
      new Notice(`2alm is up to date (${BUILD_VERSION}).`);
      return;
    }
    if (!install) {
      new Notice(`2alm ${info.remote.version} is available. Open settings to install.`, 8000);
      return;
    }
    try {
      new Notice(`Downloading 2alm ${info.remote.version}…`);
      const rel = await downloadRelease(info.base, info.remote.version, httpGet);
      await writeRelease(this.app.vault.adapter, this.manifest.dir, info.remote, rel);
      new Notice(`2alm ${info.remote.version} installed. Reloading…`);
      await this.reloadSelf();
    } catch (e) {
      new Notice('2alm update failed: ' + e.message, 10000);
    }
  }

  async reloadSelf() {
    try {
      await this.app.plugins.disablePlugin(PLUGIN_ID);
      await this.app.plugins.enablePlugin(PLUGIN_ID);
      new Notice('2alm reloaded.');
    } catch (e) {
      new Notice('2alm updated. Restart Obsidian to finish.', 10000);
    }
  }
}

class TwoAlmSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: `2alm — build ${BUILD_VERSION}` });

    new Setting(containerEl)
      .setName('Update address')
      .setDesc('Paste https://raw.githubusercontent.com/YOUR-NAME/2alm/main — the plugin reads the newest build from the main branch. Each time you upload a new version, raise the version number in manifest.json and main.js.')
      .addText((t) =>
        t
          .setPlaceholder('https://raw.githubusercontent.com/YOUR-NAME/2alm/main')
          .setValue(this.plugin.settings.updateBaseUrl)
          .onChange(async (v) => {
            this.plugin.settings.updateBaseUrl = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Check for updates')
      .setDesc('Installs a newer build if one is on the main branch.')
      .addButton((b) =>
        b
          .setButtonText('Check & install')
          .setCta()
          .onClick(() => this.plugin.checkForUpdates({ install: true }))
      );

    new Setting(containerEl)
      .setName('Palm window')
      .setDesc('Milliseconds after the pen lifts during which finger touches are ignored.')
      .addSlider((s) =>
        s
          .setLimits(200, 2000, 50)
          .setValue(this.plugin.settings.palmRejectMs)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.palmRejectMs = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Self-tests')
      .setDesc('Checks the drawing and file logic on this device.')
      .addButton((b) => b.setButtonText('Run').onClick(() => this.plugin.showSelfTests()));
  }
}

module.exports = TwoAlmPlugin;

// Internals for the test suite. Obsidian ignores extra properties on the plugin class.
TwoAlmPlugin.__internals = {
  BUILD_VERSION,
  SELF_TESTS,
  runSelfTests,
  makeStroke,
  addRawPoint,
  strokePolys,
  segmentPoly,
  dotPoly,
  signedArea,
  widthFor,
  History,
  Viewport,
  InputRouter,
  serializeNotebook,
  parseNotebook,
  normalizeBase,
  compareVersions,
  validateRemoteManifest,
  verifyMainJs,
  fetchUpdateInfo,
  downloadRelease,
  writeRelease,
  acceptExternalData,
  logEvent,
  DEBUG,
  newId,
};
