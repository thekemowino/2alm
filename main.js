/* ============================================================================
 * 2alm — Alpha 0
 * Stylus-first handwriting notebooks for Obsidian.
 *
 * Single file, no dependencies, no build step. The iPad loads this directly.
 * Sections:
 *   1. Math and smoothing (One Euro filter)
 *   2. Stroke model and geometry (outline builder, widths, simplification)
 *   3. Eraser, history (undo/redo), viewport, input routing (palm rejection)
 *   4. File format (serialize / parse with validation)
 *   5. Updater (fetch, verify, write with rollback, reload)
 *   6. Obsidian view (canvas, toolbar, pointer handling, rendering)
 *   7. Built-in self-tests (run from settings or the command palette)
 *   8. Plugin class and settings tab
 * ========================================================================== */
'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, TextFileView, Notice, Modal, requestUrl } = obsidian;

const BUILD_VERSION = '0.1.0';
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
const PREDICT = 0.5;          // fraction of the last step used to extend the live stroke for display
const SIMPLIFY_EPS = 0.12;    // page units; points closer than this to the line are dropped on save
const TEMPLATES = ['blank', 'lined', 'grid', 'dot'];
const PALETTE = ['#1d1d1f', '#0a84ff', '#ff3b30', '#34c759', '#ffd60a'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_SETTINGS = {
  updateBaseUrl: '',
  palmRejectMs: 900,
};

// ============================================================================
// 1. Math and smoothing
// ============================================================================

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d) => {
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
};
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

let idCounter = 0;
function newId() {
  idCounter = (idCounter + 1) % 1e9;
  return 's' + Date.now().toString(36) + idCounter.toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * One Euro filter (Casiez et al. 2012). Low jitter when the pen is slow, low lag when it is fast.
 * Input is in page units; time is in seconds.
 */
class OneEuroFilter {
  constructor(minCutoff = 1.2, beta = 0.01, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    if (this.x === null) {
      this.x = x;
      this.t = t;
      return x;
    }
    const dt = Math.max(t - this.t, 1e-4);
    this.t = t;
    const rawDx = (x - this.x) / dt;
    const aD = OneEuroFilter.alpha(this.dCutoff, dt);
    this.dx = aD * rawDx + (1 - aD) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = OneEuroFilter.alpha(cutoff, dt);
    this.x = a * x + (1 - a) * this.x;
    return this.x;
  }
}

// ============================================================================
// 2. Stroke model and geometry
// ============================================================================

// Tool settings. `scale` multiplies the user's size; pressure maps through [minW, maxW].
const TOOLS = {
  pen: { code: 1, scale: 1.0, minW: 0.45, maxW: 1.0, alpha: 1.0, composite: 'source-over' },
  pencil: { code: 2, scale: 0.9, minW: 0.55, maxW: 1.0, alpha: 0.72, composite: 'source-over' },
  highlighter: { code: 3, scale: 4.0, minW: 1.0, maxW: 1.0, alpha: 0.35, composite: 'multiply' },
};
const CODE_TOOL = { 1: 'pen', 2: 'pencil', 3: 'highlighter' };

function widthFor(tool, size, pressure) {
  const c = TOOLS[tool];
  const p = clamp(isNum(pressure) ? pressure : 0.5, 0, 1);
  return size * c.scale * (c.minW + (c.maxW - c.minW) * p);
}

function makeStroke(tool, color, size, pts) {
  return { id: newId(), tool, color, size, pts };
}

function distPointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function arcPts(cx, cy, r, from, to, steps) {
  const out = [];
  for (let k = 1; k < steps; k++) {
    const a = from + ((to - from) * k) / steps;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

function circlePts(cx, cy, r, steps = 16) {
  const out = [];
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * Math.PI * 2;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

/**
 * Builds a closed polygon around a variable-width polyline. Input: [{x, y, w}] where w is the
 * full width at that point. Round caps at both ends. Filled with nonzero rule as a single path,
 * so self-overlaps never darken (important for highlighter alpha).
 */
function buildOutline(pts) {
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) return circlePts(pts[0].x, pts[0].y, Math.max(pts[0].w / 2, 0.01));

  const L = new Array(n);
  const R = new Array(n);
  const th = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[i > 0 ? i - 1 : 0];
    const b = pts[i < n - 1 ? i + 1 : n - 1];
    const p = pts[i];
    const t = Math.atan2(b.y - a.y, b.x - a.x); // tangent angle, 0 when degenerate
    th[i] = t;
    const hw = p.w / 2;
    const nx = -Math.sin(t) * hw;
    const ny = Math.cos(t) * hw;
    L[i] = { x: p.x + nx, y: p.y + ny };
    R[i] = { x: p.x - nx, y: p.y - ny };
  }

  const first = pts[0];
  const last = pts[n - 1];
  const out = [];
  for (const q of L) out.push(q);
  // End cap: sweep from the left edge through the forward direction to the right edge.
  out.push(...arcPts(last.x, last.y, last.w / 2, th[n - 1] + Math.PI / 2, th[n - 1] - Math.PI / 2, 8));
  for (let i = n - 1; i >= 0; i--) out.push(R[i]);
  // Start cap: sweep from the right edge through the backward direction to the left edge.
  out.push(
    ...arcPts(first.x, first.y, first.w / 2, th[0] - Math.PI / 2, th[0] - (3 * Math.PI) / 2, 8)
  );
  return out;
}

function strokeWidths(stroke) {
  return stroke.pts.map((q) => ({ x: q.x, y: q.y, w: widthFor(stroke.tool, stroke.size, q.p) }));
}

function strokeOutlineOf(stroke) {
  return buildOutline(strokeWidths(stroke));
}

function bboxOf(poly) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const q of poly) {
    if (q.x < x1) x1 = q.x;
    if (q.y < y1) y1 = q.y;
    if (q.x > x2) x2 = q.x;
    if (q.y > y2) y2 = q.y;
  }
  return { x1, y1, x2, y2 };
}

/** Ramer–Douglas–Peucker. Every dropped point stays within eps of the kept polyline. */
function simplifyPts(pts, eps) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distPointSeg(pts[i].x, pts[i].y, pts[s].x, pts[s].y, pts[e].x, pts[e].y);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > eps) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

function polyToPath(poly) {
  const p = new Path2D();
  if (poly.length === 0) return p;
  p.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) p.lineTo(poly[i].x, poly[i].y);
  p.closePath();
  return p;
}

// ============================================================================
// 3. Eraser, history, viewport, input routing
// ============================================================================

function withPoints(stroke, pts) {
  return { id: newId(), tool: stroke.tool, color: stroke.color, size: stroke.size, pts };
}

/**
 * Stroke eraser. Tests each segment (not just each point), so fast strokes with sparse samples
 * are still erased. Splits strokes where the eraser crosses them. Returns the same array object
 * when nothing changed, so callers can detect "no change" cheaply.
 */
function eraseStrokes(strokes, cx, cy, radius) {
  let changed = false;
  const out = [];
  for (const s of strokes) {
    const r = radius + (s.size * TOOLS[s.tool].scale) / 2;
    const pts = s.pts;
    const n = pts.length;
    if (n === 1) {
      if (Math.hypot(pts[0].x - cx, pts[0].y - cy) <= r) changed = true;
      else out.push(s);
      continue;
    }
    const segErased = new Array(Math.max(n - 1, 0));
    let any = false;
    for (let i = 0; i < n - 1; i++) {
      const hit = distPointSeg(cx, cy, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= r;
      segErased[i] = hit;
      if (hit) any = true;
    }
    if (!any) {
      out.push(s);
      continue;
    }
    changed = true;
    let cur = [];
    const flush = () => {
      if (cur.length >= 2) out.push(withPoints(s, cur));
      cur = [];
    };
    for (let i = 0; i < n; i++) {
      const leftErased = i > 0 && segErased[i - 1];
      const rightErased = i < n - 1 && segErased[i];
      if (leftErased) flush();
      if (rightErased) {
        flush();
        continue;
      }
      cur.push(pts[i]);
    }
    flush();
  }
  return changed ? out : strokes;
}

/** Undo/redo over immutable snapshots. Strokes are never mutated, so snapshots are cheap. */
class History {
  constructor(present) {
    this.present = present;
    this.past = [];
    this.future = [];
  }
  /** `base` is the state before the action; `next` is the state after (already in present). */
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
  visibleRect(w, h) {
    const a = this.toPage(0, 0);
    const b = this.toPage(w, h);
    return {
      x1: Math.min(a.x, b.x),
      y1: Math.min(a.y, b.y),
      x2: Math.max(a.x, b.x),
      y2: Math.max(a.y, b.y),
    };
  }
}

/**
 * Decides what a pointer does. Pens and mouse draw. Fingers pan, unless a pen is on the glass
 * or lifted very recently (palm rejection). Works on pointer type only, no timers.
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
// 4. File format
// ============================================================================

function newPage(template = 'blank') {
  return { template, strokes: [] };
}

/**
 * Format v1 (JSON). Coordinates are quantized to 0.1 page units, pressure to 0.001, times stored
 * relative to each stroke's start. Points are flat arrays [x, y, p, t, x, y, p, t, ...].
 */
function serializeNotebook(pages) {
  return JSON.stringify({
    format: '2alm',
    v: FORMAT_VERSION,
    pages: pages.map((pg) => ({
      template: pg.template,
      strokes: pg.strokes.map((s) => {
        const t0 = s.pts.length ? s.pts[0].t : 0;
        const flat = [];
        for (const q of s.pts) flat.push(round(q.x, 1), round(q.y, 1), round(q.p, 3), Math.round(q.t - t0));
        return { id: s.id, t: TOOLS[s.tool].code, c: s.color, s: round(s.size, 2), p: flat };
      }),
    })),
  });
}

function newNotebookText() {
  return serializeNotebook([newPage('blank')]);
}

/** Throws a descriptive Error for anything that is not a valid 2alm file. */
function parseNotebook(text) {
  if (typeof text !== 'string' || !text.trim()) return { pages: [newPage('blank')] };
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
      const tool = s ? CODE_TOOL[s.t] : undefined;
      if (!tool) throw new Error('unknown tool code');
      if (!Array.isArray(s.p) || s.p.length % 4 !== 0 || !s.p.every(isNum)) {
        throw new Error('malformed point data');
      }
      if (!isNum(s.s) || s.s <= 0 || s.s > 500) throw new Error('invalid stroke size');
      const pts = [];
      for (let k = 0; k < s.p.length; k += 4) {
        pts.push({ x: s.p[k], y: s.p[k + 1], p: clamp(s.p[k + 2], 0, 1), t: s.p[k + 3] });
      }
      return {
        id: typeof s.id === 'string' ? s.id : newId(),
        tool,
        color: COLOR_RE.test(s.c) ? s.c : PALETTE[0],
        size: s.s,
        pts,
      };
    });
    return { template: TEMPLATES.includes(pg.template) ? pg.template : 'blank', strokes };
  });
  if (!pages.length) pages.push(newPage('blank'));
  return { pages };
}

// ============================================================================
// 5. Updater
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

/**
 * Writes the release into the plugin folder. Keeps main.js.bak. If any write fails, restores
 * the previous files so the plugin keeps working.
 */
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
// 6. Obsidian view
// ============================================================================

const ICONS = {
  pen: 'M4 20l4-1L19 8l-3-3L5 16z',
  pencil: 'M4 20h4l11-11-4-4L4 16v4zM13 7l4 4',
  highlighter: 'M5 19h14M7 15l6-6 4 4-6 6H7z',
  eraser: 'M3 17l8-8 7 7-4 4H7zM12 21h9',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-4',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 000 10h4',
  prev: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
  add: 'M12 5v14M5 12h14',
  template: 'M4 4h16v16H4zM4 9h16M4 14h16',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
};
const iconSvg = (d) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

function drawTemplate(ctx, template, view) {
  if (template === 'blank') return;
  const step = 40;
  const x1 = Math.max(0, view.x1);
  const x2 = Math.min(PAGE_W, view.x2);
  const y1 = Math.max(0, view.y1);
  const y2 = Math.min(PAGE_H, view.y2);
  ctx.save();
  ctx.strokeStyle = 'rgba(40, 90, 140, 0.18)';
  ctx.fillStyle = 'rgba(40, 90, 140, 0.30)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (template === 'lined' || template === 'grid') {
    for (let y = Math.ceil(y1 / step) * step; y <= y2; y += step) {
      if (y <= 0 || y >= PAGE_H) continue;
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
    }
  }
  if (template === 'grid') {
    for (let x = Math.ceil(x1 / step) * step; x <= x2; x += step) {
      if (x <= 0 || x >= PAGE_W) continue;
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
    }
  }
  ctx.stroke();
  if (template === 'dot') {
    ctx.beginPath();
    for (let y = Math.ceil(y1 / step) * step; y <= y2; y += step) {
      for (let x = Math.ceil(x1 / step) * step; x <= x2; x += step) {
        if (x <= 0 || y <= 0 || x >= PAGE_W || y >= PAGE_H) continue;
        ctx.moveTo(x + 1.4, y);
        ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }
  ctx.restore();
}

class NotebookView extends TextFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.pages = [];          // [{ template, hist: History }]
    this.pageIndex = 0;
    this.rawData = '';        // exactly what was loaded; written back if the file is unreadable
    this.loadError = null;
    this.vp = new Viewport();
    this.viewReady = false;
    this.router = new InputRouter(plugin.settings.palmRejectMs);
    this.tool = 'pen';
    this.color = PALETTE[0];
    this.size = 2.5;
    this.live = null;         // stroke being drawn: { id, tool, color, size, pts, fx, fy, pSm }
    this.erasing = null;      // { id, base }
    this.touches = new Map(); // finger pointerId -> { x, y }
    this.pinch = null;
    this.raf = 0;
    this.pathCache = new WeakMap();
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
    this.ro = null;
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

  getViewData() {
    if (this.loadError) return this.rawData; // never overwrite a file we could not read
    if (!this.pages.length) return newNotebookText();
    return serializeNotebook(this.pages.map((p) => ({ template: p.template, strokes: p.hist.present })));
  }

  setViewData(data, clear) {
    this.rawData = data;
    this.loadError = null;
    this.live = null;
    this.erasing = null;
    this.touches.clear();
    try {
      const nb = parseNotebook(data);
      this.pages = nb.pages.map((p) => ({ template: p.template, hist: new History(p.strokes) }));
      this.pageIndex = clamp(this.pageIndex, 0, this.pages.length - 1);
    } catch (e) {
      this.loadError = e.message;
      this.pages = [];
      new Notice('2alm: this notebook could not be read — ' + e.message, 9000);
    }
    this.ensureDom();
    if (!this.viewReady) this.resetView();
    this.refreshChrome();
    this.schedule();
  }

  clear() {
    this.pages = [];
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
    root.tabIndex = 0;
    if (this.plugin.settings.reducedMotion) root.addClass('is-reduced-motion');

    this.toolbar = root.createDiv({ cls: 'twoalm-toolbar' });
    this.stage = root.createDiv({ cls: 'twoalm-stage' });
    this.canvas = this.stage.createEl('canvas', { cls: 'twoalm-canvas' });
    this.ctx = this.canvas.getContext('2d');
    this.pageBar = root.createDiv({ cls: 'twoalm-pagebar' });

    this.buildToolbar();
    this.buildPageBar();

    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    root.addEventListener('keydown', (e) => this.onKey(e));

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.stage);
    }
    this.resize();
  }

  buildToolbar() {
    const tb = this.toolbar;
    const group = () => tb.createDiv({ cls: 'twoalm-group' });
    const button = (parent, icon, title, onClick) => {
      const b = parent.createEl('button', { cls: 'twoalm-btn', attr: { 'aria-label': title, title } });
      b.innerHTML = iconSvg(icon);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      return b;
    };

    const tools = group();
    this.toolBtns = {
      pen: button(tools, ICONS.pen, 'Pen (P)', () => this.setTool('pen')),
      pencil: button(tools, ICONS.pencil, 'Pencil (L)', () => this.setTool('pencil')),
      highlighter: button(tools, ICONS.highlighter, 'Highlighter (H)', () => this.setTool('highlighter')),
      eraser: button(tools, ICONS.eraser, 'Eraser (E)', () => this.setTool('eraser')),
    };

    const colors = group();
    this.swatchEls = PALETTE.map((c) => {
      const s = colors.createEl('button', { cls: 'twoalm-swatch', attr: { title: c, 'aria-label': c } });
      s.style.background = c;
      s.addEventListener('click', (e) => {
        e.stopPropagation();
        this.color = c;
        this.refreshChrome();
      });
      return s;
    });

    const sizeGroup = group();
    const slider = sizeGroup.createEl('input', {
      cls: 'twoalm-size',
      attr: { type: 'range', min: '1', max: '12', step: '0.5', 'aria-label': 'Size', title: 'Size' },
    });
    slider.value = String(this.size);
    slider.addEventListener('input', () => {
      this.size = Number(slider.value);
    });

    const history = group();
    this.btnUndo = button(history, ICONS.undo, 'Undo (Ctrl/Cmd+Z)', () => this.undo());
    this.btnRedo = button(history, ICONS.redo, 'Redo (Ctrl/Cmd+Shift+Z)', () => this.redo());

    const view = group();
    button(view, ICONS.fit, 'Reset zoom', () => {
      this.resetView();
      this.schedule();
    });
  }

  buildPageBar() {
    const pb = this.pageBar;
    const button = (icon, title, onClick) => {
      const b = pb.createEl('button', { cls: 'twoalm-btn', attr: { 'aria-label': title, title } });
      b.innerHTML = iconSvg(icon);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      return b;
    };
    this.btnPrev = button(ICONS.prev, 'Previous page', () => this.goPage(this.pageIndex - 1));
    this.pageLabel = pb.createDiv({ cls: 'twoalm-label' });
    this.btnNext = button(ICONS.next, 'Next page', () => this.goPage(this.pageIndex + 1));
    button(ICONS.add, 'New blank page', () => this.addPage());
    button(ICONS.template, 'Cycle page template', () => this.cycleTemplate());
  }

  refreshChrome() {
    if (!this.toolBtns) return;
    const page = this.currentPage();
    for (const [name, btn] of Object.entries(this.toolBtns)) btn.toggleClass('is-active', name === this.tool);
    PALETTE.forEach((c, i) => this.swatchEls[i].toggleClass('is-active', c === this.color));
    this.btnUndo.disabled = !(page && page.hist.canUndo);
    this.btnRedo.disabled = !(page && page.hist.canRedo);
    this.pageLabel.setText(this.pages.length ? `${this.pageIndex + 1} / ${this.pages.length}` : '');
    this.btnPrev.disabled = this.pageIndex <= 0;
    this.btnNext.disabled = this.pageIndex >= this.pages.length - 1;
  }

  currentPage() {
    return this.pages[this.pageIndex] || null;
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
    const s = clamp(Math.min((this.cssW - 40) / PAGE_W, (this.cssH - 90) / PAGE_H), MIN_SCALE, MAX_SCALE);
    this.vp.scale = s;
    this.vp.tx = (this.cssW - PAGE_W * s) / 2;
    this.vp.ty = 56;
    this.viewReady = true;
  }

  toPage(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.vp.toPage(e.clientX - r.left, e.clientY - r.top);
  }

  // ---- tools and pages ----

  setTool(t) {
    this.tool = t;
    this.refreshChrome();
  }

  undo() {
    const page = this.currentPage();
    if (page && page.hist.undo()) {
      this.commitChange();
    }
  }

  redo() {
    const page = this.currentPage();
    if (page && page.hist.redo()) {
      this.commitChange();
    }
  }

  commitChange() {
    this.refreshChrome();
    this.schedule();
    this.requestSave();
  }

  goPage(i) {
    if (i < 0 || i >= this.pages.length) return;
    this.pageIndex = i;
    this.live = null;
    this.erasing = null;
    this.refreshChrome();
    this.schedule();
  }

  addPage() {
    if (this.loadError) return;
    this.pages.push({ template: 'blank', hist: new History([]) });
    this.pageIndex = this.pages.length - 1;
    this.requestSave();
    this.refreshChrome();
    this.schedule();
  }

  cycleTemplate() {
    const page = this.currentPage();
    if (!page || this.loadError) return;
    page.template = TEMPLATES[(TEMPLATES.indexOf(page.template) + 1) % TEMPLATES.length];
    this.requestSave();
    this.schedule();
  }

  onKey(e) {
    if (e.target && e.target.tagName === 'INPUT') return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      this.redo();
    } else if (!mod) {
      const map = { p: 'pen', l: 'pencil', h: 'highlighter', e: 'eraser' };
      if (map[key]) this.setTool(map[key]);
    }
  }

  // ---- pointer input ----

  onPointerDown(e) {
    if (this.loadError || !this.pages.length) return;
    this.router.down(e.pointerId, e.pointerType);
    const decision = this.router.decide(e.pointerType, e.timeStamp);
    if (decision === 'draw') {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.pointerType === 'pen') this.touches.clear(); // a pen cancels any finger pan
      this.canvas.setPointerCapture(e.pointerId);
      this.beginStroke(e);
    } else if (decision === 'pan') {
      this.canvas.setPointerCapture(e.pointerId);
      this.beginTouch(e);
    }
  }

  onPointerMove(e) {
    if (this.live && e.pointerId === this.live.id) {
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ev of list.length ? list : [e]) this.addPoint(this.live, ev, this.toPage(ev));
      this.schedule();
    } else if (this.erasing && e.pointerId === this.erasing.id) {
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ev of list.length ? list : [e]) this.eraseAt(this.toPage(ev));
    } else if (this.touches.has(e.pointerId)) {
      this.moveTouch(e);
    }
  }

  onPointerUp(e) {
    this.router.up(e.pointerId, e.pointerType, e.timeStamp);
    if (this.live && e.pointerId === this.live.id) {
      this.finishStroke();
    } else if (this.erasing && e.pointerId === this.erasing.id) {
      this.finishErase();
    } else if (this.touches.has(e.pointerId)) {
      this.touches.delete(e.pointerId);
      this.pinch = null;
      if (this.touches.size === 2) this.startPinch();
    }
  }

  beginStroke(e) {
    const page = this.currentPage();
    if (!page) return;
    const pt = this.toPage(e);
    if (this.tool === 'eraser') {
      this.erasing = { id: e.pointerId, base: page.hist.present };
      this.eraseAt(pt);
      return;
    }
    const cfg = TOOLS[this.tool];
    this.live = {
      id: e.pointerId,
      tool: this.tool,
      color: this.color,
      size: this.size,
      pts: [],
      fx: new OneEuroFilter(),
      fy: new OneEuroFilter(),
      pSm: null,
      alpha: cfg.alpha,
    };
    this.addPoint(this.live, e, pt);
    this.schedule();
  }

  addPoint(live, e, pt) {
    const t = e.timeStamp / 1000;
    const x = live.fx.filter(pt.x, t);
    const y = live.fy.filter(pt.y, t);
    const raw = e.pressure > 0 ? e.pressure : 0.5; // 0 means "no pressure data"
    live.pSm = live.pSm === null ? raw : live.pSm * 0.6 + raw * 0.4;
    live.pts.push({ x, y, p: live.pSm, t: e.timeStamp });
  }

  finishStroke() {
    const live = this.live;
    this.live = null;
    const page = this.currentPage();
    if (!live || !page || live.pts.length === 0) return;
    const pts = simplifyPts(live.pts, SIMPLIFY_EPS);
    const stroke = makeStroke(live.tool, live.color, live.size, pts);
    page.hist.commit(page.hist.present, [...page.hist.present, stroke]);
    this.commitChange();
  }

  eraseAt(pt) {
    const page = this.currentPage();
    if (!page) return;
    const radius = Math.max(4, this.size * 3);
    const next = eraseStrokes(page.hist.present, pt.x, pt.y, radius);
    if (next !== page.hist.present) {
      page.hist.present = next;
      this.schedule();
    }
  }

  finishErase() {
    const base = this.erasing.base;
    this.erasing = null;
    const page = this.currentPage();
    if (page && page.hist.commit(base, page.hist.present)) this.commitChange();
  }

  beginTouch(e) {
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.touches.size === 2) this.startPinch();
  }

  startPinch() {
    const pts = [...this.touches.values()];
    const mx = (pts[0].x + pts[1].x) / 2;
    const my = (pts[0].y + pts[1].y) / 2;
    this.pinch = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), mx, my };
  }

  moveTouch(e) {
    const prev = this.touches.get(e.pointerId);
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.touches.size === 1) {
      this.vp.panBy(e.clientX - prev.x, e.clientY - prev.y);
    } else if (this.touches.size >= 2 && this.pinch) {
      const pts = [...this.touches.values()];
      const mx = (pts[0].x + pts[1].x) / 2;
      const my = (pts[0].y + pts[1].y) / 2;
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const r = this.canvas.getBoundingClientRect();
      if (this.pinch.d > 0 && d > 0) {
        this.vp.zoomAt(mx - r.left, my - r.top, d / this.pinch.d);
      }
      this.vp.panBy(mx - this.pinch.mx, my - this.pinch.my);
      this.pinch = { d, mx, my };
    }
    this.schedule();
  }

  onWheel(e) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey) this.vp.zoomAt(sx, sy, Math.exp(-e.deltaY * 0.01));
    else this.vp.panBy(-e.deltaX, -e.deltaY);
    this.schedule();
  }

  // ---- rendering ----

  schedule() {
    if (this.raf || !this.canvas) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  strokePath(s) {
    let c = this.pathCache.get(s);
    if (!c) {
      const poly = strokeOutlineOf(s);
      c = { path: polyToPath(poly), box: poly.length ? bboxOf(poly) : null };
      this.pathCache.set(s, c);
    }
    return c;
  }

  paint() {
    const ctx = this.ctx;
    const vp = this.vp;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = document.body.classList.contains('theme-dark') ? '#1e1e1e' : '#e7e5df';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const page = this.currentPage();
    if (!page) return;
    const dpr = this.dpr;
    ctx.setTransform(dpr * vp.scale, 0, 0, dpr * vp.scale, dpr * vp.tx, dpr * vp.ty);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);

    const view = vp.visibleRect(this.cssW, this.cssH);
    drawTemplate(ctx, page.template, view);

    for (const s of page.hist.present) {
      const c = this.strokePath(s);
      if (!c.box) continue;
      if (c.box.x2 < view.x1 || c.box.x1 > view.x2 || c.box.y2 < view.y1 || c.box.y1 > view.y2) continue;
      const cfg = TOOLS[s.tool];
      ctx.globalAlpha = cfg.alpha;
      ctx.globalCompositeOperation = cfg.composite;
      ctx.fillStyle = s.color;
      ctx.fill(c.path);
    }

    if (this.live) this.paintLive(ctx, view);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  paintLive(ctx, view) {
    const L = this.live;
    const pts = L.pts.slice();
    if (pts.length >= 2) {
      // Show the pen slightly ahead of the last smoothed sample. Display only; never stored.
      const a = pts[pts.length - 2];
      const b = pts[pts.length - 1];
      pts.push({ x: b.x + (b.x - a.x) * PREDICT, y: b.y + (b.y - a.y) * PREDICT, p: b.p, t: b.t });
    }
    const poly = strokeOutlineOf({ tool: L.tool, size: L.size, pts });
    if (!poly.length) return;
    const cfg = TOOLS[L.tool];
    ctx.globalAlpha = cfg.alpha;
    ctx.globalCompositeOperation = cfg.composite;
    ctx.fillStyle = L.color;
    ctx.fill(polyToPath(poly));
  }
}

// ============================================================================
// 7. Built-in self-tests
// ============================================================================

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertClose(a, b, eps, msg) {
  assert(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);
}
function lineStroke(x1, y1, x2, y2, n, tool = 'pen', size = 2) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0 : i / (n - 1);
    pts.push({ x: x1 + (x2 - x1) * f, y: y1 + (y2 - y1) * f, p: 0.6, t: i * 8 });
  }
  return makeStroke(tool, PALETTE[0], size, pts);
}
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

const SELF_TESTS = [
  // --- smoothing
  {
    name: 'One Euro: first sample passes through unchanged',
    run() {
      assert(new OneEuroFilter().filter(5, 0) === 5, 'first sample changed');
    },
  },
  {
    name: 'One Euro: converges to a constant input',
    run() {
      const f = new OneEuroFilter();
      let y = 0;
      for (let i = 0; i < 300; i++) y = f.filter(10, i / 120);
      assertClose(y, 10, 1e-3, 'did not converge');
    },
  },
  {
    name: 'One Euro: reduces jitter when the pen is nearly still',
    run() {
      const f = new OneEuroFilter();
      const ins = [];
      const outs = [];
      for (let i = 0; i < 600; i++) {
        const x = (i % 2 ? 1 : -1) * 0.5;
        ins.push(x);
        outs.push(f.filter(x, i / 120));
      }
      const variance = (a) => {
        const m = a.reduce((s, q) => s + q, 0) / a.length;
        return a.reduce((s, q) => s + (q - m) * (q - m), 0) / a.length;
      };
      assert(variance(outs.slice(100)) < variance(ins.slice(100)) * 0.5, 'jitter not reduced enough');
    },
  },

  // --- geometry
  {
    name: 'Outline: a single point becomes a circle of the right radius',
    run() {
      const poly = buildOutline([{ x: 10, y: 20, w: 4 }]);
      assert(poly.length >= 8, 'too few points');
      for (const q of poly) assertClose(Math.hypot(q.x - 10, q.y - 20), 2, 1e-9, 'radius');
    },
  },
  {
    name: 'Outline: a straight line covers its width and both round caps',
    run() {
      const pts = [];
      for (let i = 0; i < 10; i++) pts.push({ x: i * 10, y: 0, w: 6 });
      const poly = buildOutline(pts);
      const ys = poly.map((q) => q.y);
      const xs = poly.map((q) => q.x);
      assertClose(Math.max(...ys), 3, 1e-6, 'top edge');
      assertClose(Math.min(...ys), -3, 1e-6, 'bottom edge');
      assertClose(Math.min(...xs), -3, 1e-6, 'start cap');
      assertClose(Math.max(...xs), 93, 1e-6, 'end cap');
    },
  },
  {
    name: 'Outline: random strokes always produce finite coordinates',
    run() {
      const rnd = seededRandom(7);
      for (let k = 0; k < 200; k++) {
        const n = 1 + Math.floor(rnd() * 40);
        const pts = [];
        for (let i = 0; i < n; i++) pts.push({ x: rnd() * 1000, y: rnd() * 1400, w: rnd() * 12 });
        for (const q of buildOutline(pts)) assert(Number.isFinite(q.x) && Number.isFinite(q.y), 'non-finite');
      }
    },
  },
  {
    name: 'Width: pressure widens the pen; highlighter ignores pressure',
    run() {
      assert(widthFor('pen', 2, 1) > widthFor('pen', 2, 0), 'pen pressure');
      assertClose(widthFor('highlighter', 2, 0), widthFor('highlighter', 2, 1), 1e-9, 'highlighter');
      assert(widthFor('highlighter', 2, 0.5) > widthFor('pen', 2, 0.5), 'highlighter should be wider');
    },
  },
  {
    name: 'Width: always positive and finite, including bad pressure values',
    run() {
      for (const tool of Object.keys(TOOLS)) {
        for (const p of [-1, 0, 0.5, 1, 2, NaN, undefined]) {
          const w = widthFor(tool, 3, p);
          assert(Number.isFinite(w) && w > 0, `${tool} ${p} -> ${w}`);
        }
      }
    },
  },
  {
    name: 'Simplify: keeps endpoints and removes collinear points',
    run() {
      const pts = [];
      for (let i = 0; i <= 20; i++) pts.push({ x: i, y: i * 2, p: 0.5, t: i });
      const s = simplifyPts(pts, 0.01);
      assert(s.length === 2, `expected 2 points, got ${s.length}`);
      assert(s[0] === pts[0] && s[1] === pts[20], 'endpoints changed');
    },
  },
  {
    name: 'Simplify: every dropped point is within epsilon of the kept line',
    run() {
      const rnd = seededRandom(11);
      const pts = [];
      let x = 0;
      let y = 0;
      for (let i = 0; i < 300; i++) {
        x += rnd() * 3;
        y += (rnd() - 0.5) * 4;
        pts.push({ x, y, p: 0.5, t: i });
      }
      const eps = 0.5;
      const kept = simplifyPts(pts, eps);
      for (const q of pts) {
        let best = Infinity;
        for (let i = 0; i < kept.length - 1; i++) {
          best = Math.min(best, distPointSeg(q.x, q.y, kept[i].x, kept[i].y, kept[i + 1].x, kept[i + 1].y));
        }
        assert(best <= eps + 1e-9, `point ${best} away from the line`);
      }
    },
  },

  // --- eraser, history, viewport, input
  {
    name: 'Eraser: far from every stroke changes nothing (same array returned)',
    run() {
      const s = [lineStroke(0, 0, 100, 0, 21)];
      assert(eraseStrokes(s, 500, 500, 5) === s, 'array reference changed');
    },
  },
  {
    name: 'Eraser: cutting the middle splits one stroke into two and keeps its style',
    run() {
      const s = [lineStroke(0, 0, 100, 0, 21, 'pen', 2)];
      const out = eraseStrokes(s, 50, 0, 3);
      assert(out.length === 2, `expected 2 pieces, got ${out.length}`);
      assert(out[0].pts.every((q) => q.x < 47), 'left piece too long');
      assert(out[1].pts.every((q) => q.x > 53), 'right piece too long');
      assert(out[0].tool === 'pen' && out[0].size === 2 && out[0].color === s[0].color, 'style lost');
    },
  },
  {
    name: 'Eraser: a fast stroke with sparse samples is still erased between points',
    run() {
      const s = [lineStroke(0, 0, 200, 0, 2)];
      assert(eraseStrokes(s, 100, 0, 2).length === 0, 'segment between samples was missed');
    },
  },
  {
    name: 'Eraser: single-point strokes are removed when hit',
    run() {
      const dot = makeStroke('pen', PALETTE[0], 2, [{ x: 10, y: 10, p: 0.5, t: 0 }]);
      assert(eraseStrokes([dot], 10, 10, 2).length === 0, 'dot survived');
      assert(eraseStrokes([dot], 500, 500, 2).length === 1, 'far dot removed');
    },
  },
  {
    name: 'History: undo and redo walk the states; a new action clears redo',
    run() {
      const h = new History([]);
      const a = [1];
      const b = [1, 2];
      h.commit(h.present, a);
      h.commit(h.present, b);
      assert(h.undo() && h.present === a, 'undo 1');
      assert(h.undo() && h.present.length === 0, 'undo 2');
      assert(!h.undo(), 'undo past start');
      assert(h.redo() && h.present === a, 'redo');
      h.commit(h.present, [9]);
      assert(!h.redo(), 'redo should be cleared by a new action');
    },
  },
  {
    name: 'History: committing an identical state is ignored',
    run() {
      const h = new History([1]);
      assert(h.commit(h.present, h.present) === false, 'identical commit recorded');
      assert(!h.canUndo, 'undo became available');
    },
  },
  {
    name: 'History: stays bounded at the maximum depth',
    run() {
      const h = new History(0);
      for (let i = 1; i <= MAX_HISTORY + 50; i++) h.commit(h.present, i);
      assert(h.past.length === MAX_HISTORY, `past length ${h.past.length}`);
    },
  },
  {
    name: 'Viewport: toPage inverts toScreen after pan and zoom',
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
    name: 'Viewport: zooming keeps the focal point under the finger',
    run() {
      const v = new Viewport();
      const before = v.toPage(200, 300);
      v.zoomAt(200, 300, 1.7);
      const after = v.toScreen(before.x, before.y);
      assertClose(after.x, 200, 1e-9, 'x');
      assertClose(after.y, 300, 1e-9, 'y');
    },
  },
  {
    name: 'Viewport: zoom is clamped to the allowed range',
    run() {
      const v = new Viewport();
      v.zoomAt(0, 0, 1e6);
      assertClose(v.scale, MAX_SCALE, 1e-12, 'max');
      v.zoomAt(0, 0, 1e-9);
      assertClose(v.scale, MIN_SCALE, 1e-12, 'min');
    },
  },
  {
    name: 'Input: pen and mouse always draw',
    run() {
      const r = new InputRouter(900);
      assert(r.decide('pen', 0) === 'draw', 'pen');
      assert(r.decide('mouse', 0) === 'draw', 'mouse');
    },
  },
  {
    name: 'Palm rejection: fingers are ignored while the pen is down',
    run() {
      const r = new InputRouter(900);
      r.down(1, 'pen');
      assert(r.decide('touch', 10) === 'ignore', 'touch accepted during pen contact');
      r.up(1, 'pen', 50);
    },
  },
  {
    name: 'Palm rejection: fingers are ignored briefly after the pen lifts, then pan',
    run() {
      const r = new InputRouter(900);
      r.down(1, 'pen');
      r.up(1, 'pen', 100);
      assert(r.decide('touch', 500) === 'ignore', 'inside the window');
      assert(r.decide('touch', 1200) === 'pan', 'after the window');
    },
  },
  {
    name: 'Input: a finger pans when no pen has been used',
    run() {
      assert(new InputRouter(900).decide('touch', 5000) === 'pan', 'finger did not pan');
    },
  },

  // --- file format
  {
    name: 'Format: round trip keeps tools, colours, sizes and coordinates',
    run() {
      const strokes = [
        makeStroke('pen', '#0a84ff', 2.5, [
          { x: 10.04, y: 20.06, p: 0.7, t: 1000 },
          { x: 30.5, y: 40.25, p: 0.2, t: 1016 },
        ]),
        makeStroke('highlighter', '#ffd60a', 4, [
          { x: 5, y: 5, p: 0.5, t: 50 },
          { x: 80, y: 6, p: 0.5, t: 66 },
        ]),
      ];
      const nb = parseNotebook(serializeNotebook([{ template: 'lined', strokes }]));
      assert(nb.pages.length === 1 && nb.pages[0].template === 'lined', 'page or template');
      const got = nb.pages[0].strokes;
      assert(got.length === 2, 'stroke count');
      assert(got[0].tool === 'pen' && got[1].tool === 'highlighter', 'tools');
      assert(got[0].color === '#0a84ff' && got[1].color === '#ffd60a', 'colours');
      assertClose(got[0].size, 2.5, 1e-9, 'size');
      assertClose(got[0].pts[0].x, 10.0, 0.051, 'x');
      assertClose(got[0].pts[1].y, 40.3, 0.051, 'y');
      assertClose(got[0].pts[0].p, 0.7, 0.0011, 'pressure');
      assert(got[0].pts[1].t === 16, 'times are stored relative to the stroke start');
    },
  },
  {
    name: 'Format: rejects foreign, future and malformed files',
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
    name: 'Format: an empty file opens as a blank notebook',
    run() {
      const nb = parseNotebook('');
      assert(nb.pages.length === 1 && nb.pages[0].strokes.length === 0, 'not blank');
    },
  },
  {
    name: 'Format: unknown templates fall back to blank',
    run() {
      const text = JSON.stringify({ format: '2alm', v: 1, pages: [{ template: 'hologram', strokes: [] }] });
      assert(parseNotebook(text).pages[0].template === 'blank', 'template not normalised');
    },
  },

  // --- updater
  {
    name: 'Updates: versions compare numerically, not as text',
    run() {
      assert(compareVersions('0.10.0', '0.9.0') > 0, '0.10.0 vs 0.9.0');
      assert(compareVersions('1.0', '1.0.0') === 0, '1.0 vs 1.0.0');
      assert(compareVersions('0.1.0', '0.1.1') < 0, '0.1.0 vs 0.1.1');
    },
  },
  {
    name: 'Updates: only https update URLs are accepted',
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
    name: 'Updates: the remote manifest must belong to this plugin',
    run() {
      validateRemoteManifest({ id: '2alm', version: '0.2.0' });
      let threw = false;
      try {
        validateRemoteManifest({ id: 'something-else', version: '0.2.0' });
      } catch (e) {
        threw = true;
      }
      assert(threw, 'accepted another plugin');
    },
  },
  {
    name: 'Updates: downloaded main.js must match the advertised build and compile',
    run() {
      verifyMainJs("const BUILD_VERSION = '0.2.0';\nmodule.exports = {};", '0.2.0');
      let threw = 0;
      for (const [js, v] of [
        ["const BUILD_VERSION = '0.2.0';", '0.3.0'],
        ['module.exports = {};', '0.2.0'],
        ["const BUILD_VERSION = '0.2.0'; function (", '0.2.0'],
      ]) {
        try {
          verifyMainJs(js, v);
        } catch (e) {
          threw++;
        }
      }
      assert(threw === 3, `only ${threw} of 3 bad builds were rejected`);
    },
  },

  // --- performance budgets (generous; reported in the results list)
  {
    name: 'Budget: outlining 5000 points takes under 250 ms',
    run() {
      const rnd = seededRandom(3);
      const pts = [];
      for (let i = 0; i < 5000; i++) pts.push({ x: rnd() * 1000, y: rnd() * 1400, p: rnd(), t: i });
      const t0 = now();
      strokeOutlineOf(makeStroke('pen', PALETTE[0], 3, pts));
      const ms = now() - t0;
      assert(ms < 250, `took ${ms.toFixed(1)} ms`);
    },
  },
  {
    name: 'Budget: erasing across 1000 strokes takes under 100 ms',
    run() {
      const strokes = [];
      for (let i = 0; i < 1000; i++) strokes.push(lineStroke(0, i * 1.4, 1000, i * 1.4, 30));
      const t0 = now();
      eraseStrokes(strokes, 500, 700, 8);
      const ms = now() - t0;
      assert(ms < 100, `took ${ms.toFixed(1)} ms`);
    },
  },
  {
    name: 'Budget: saving 2000 strokes takes under 500 ms',
    run() {
      const strokes = [];
      for (let i = 0; i < 2000; i++) strokes.push(lineStroke(0, i * 0.7, 900, i * 0.7, 40));
      const t0 = now();
      const text = serializeNotebook([{ template: 'blank', strokes }]);
      const ms = now() - t0;
      assert(ms < 500, `took ${ms.toFixed(1)} ms`);
      assert(parseNotebook(text).pages[0].strokes.length === 2000, 'lost strokes');
    },
  },
  {
    name: 'Stroke ids are unique across 10000 generated ids',
    run() {
      const set = new Set();
      for (let i = 0; i < 10000; i++) set.add(newId());
      assert(set.size === 10000, 'duplicate ids');
    },
  },
];

/** Runs the list and returns one result per test. Never throws. */
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
      const li = list.createEl('li');
      li.setText(`${r.ok ? '✓' : '✗'} ${r.name} (${r.ms.toFixed(1)} ms)${r.ok ? '' : ' — ' + r.error}`);
    }
  }
  onClose() {
    this.contentEl.empty();
  }
}

// ============================================================================
// 8. Plugin class and settings
// ============================================================================

class TwoAlmPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new NotebookView(leaf, this));
    this.registerExtensions([FILE_EXT], VIEW_TYPE);

    this.addRibbonIcon('pen-tool', '2alm: new notebook', () => this.createNotebook());
    this.addCommand({ id: 'new-notebook', name: 'New notebook', callback: () => this.createNotebook() });
    this.addCommand({
      id: 'check-for-updates',
      name: 'Check for 2alm updates and install',
      callback: () => this.checkForUpdates({ install: true }),
    });
    this.addCommand({ id: 'run-self-tests', name: 'Run 2alm engine self-tests', callback: () => this.showSelfTests() });
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

  /** Checks GitHub (or any https host) for a newer build. Installs it when install is true. */
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
    containerEl.createEl('h2', { text: `2alm — alpha 0 (build ${BUILD_VERSION})` });

    new Setting(containerEl)
      .setName('Update URL')
      .setDesc('https address of the folder with manifest.json, main.js and styles.css. For GitHub releases use https://github.com/YOUR-NAME/2alm/releases/latest/download')
      .addText((t) =>
        t
          .setPlaceholder('https://github.com/…/releases/latest/download')
          .setValue(this.plugin.settings.updateBaseUrl)
          .onChange(async (v) => {
            this.plugin.settings.updateBaseUrl = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Check for updates')
      .setDesc('Looks for a newer build and installs it. Obsidian reloads the plugin afterwards.')
      .addButton((b) =>
        b
          .setButtonText('Check & install')
          .setCta()
          .onClick(() => this.plugin.checkForUpdates({ install: true }))
      );

    new Setting(containerEl)
      .setName('Palm rejection window')
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
      .setName('Engine self-tests')
      .setDesc('Runs the built-in checks for the writing engine on this device.')
      .addButton((b) => b.setButtonText('Run').onClick(() => this.plugin.showSelfTests()));
  }
}

module.exports = TwoAlmPlugin;

// Internals exposed for the test suite. Obsidian ignores extra properties on the plugin class.
TwoAlmPlugin.__internals = {
  BUILD_VERSION,
  SELF_TESTS,
  runSelfTests,
  OneEuroFilter,
  buildOutline,
  widthFor,
  simplifyPts,
  eraseStrokes,
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
  makeStroke,
};
