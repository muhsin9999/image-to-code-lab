import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveDependency, requireDependency } from './common.mjs';
import { recognizeText, readLines } from './ocr.mjs';
import { catalogAssets } from './design-hints.mjs';

const require = createRequire(import.meta.url);
const sharp = require(resolveDependency('sharp'));
const { chromium } = requireDependency('playwright');
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hex = rgb => '#' + rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const r1 = v => Math.round(v * 10) / 10;
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const intersects = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const inside = (a, b, pad = 0) => a[0] >= b[0] - pad && a[1] >= b[1] - pad && a[0] + a[2] <= b[0] + b[2] + pad && a[1] + a[3] <= b[1] + b[3] + pad;
const grow = (b, n, W, H) => { const x = clamp(b[0] - n, 0, W - 1), y = clamp(b[1] - n, 0, H - 1);
  return [x, y, clamp(b[0] + b[2] + n, 0, W) - x, clamp(b[1] + b[3] + n, 0, H) - y]; };
const union = boxes => { const x = Math.min(...boxes.map(b => b[0])), y = Math.min(...boxes.map(b => b[1]));
  return [x, y, Math.max(...boxes.map(b => b[0] + b[2])) - x, Math.max(...boxes.map(b => b[1] + b[3])) - y]; };

function makeImage(data, width, height) {
  return { data, width, height, at(x, y) { const i = (y * width + x) * 3; return [data[i], data[i + 1], data[i + 2]]; } };
}

function modeColor(points, bucket = 8) {
  const counts = new Map();
  for (const rgb of points) {
    const key = rgb.map(v => Math.round(v / bucket)).join(',');
    const item = counts.get(key) || { n: 0, sum: [0, 0, 0] };
    item.n++; rgb.forEach((v, i) => { item.sum[i] += v; });
    counts.set(key, item);
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  if (!best) return { color: [255, 255, 255], coverage: 0 };
  return { color: best.sum.map(v => v / best.n), coverage: best.n / points.length };
}

// A row's page background: the colour both page edges agree on (a wide image or card in the middle
// does not change it); otherwise the row's dominant colour (sidebars, split banners).
function rowBackground(img, y, pts) {
  // a few rows at a time, so a fine striped texture does not read as a new colour on every row
  const ys = [-2, -1, 0, 1, 2].map(d => clamp(y + d, 0, img.height - 1));
  const left = modeColor([0, 3, 6, 9, 12].flatMap(x => ys.map(yy => img.at(x, yy))), 12);
  const right = modeColor([1, 4, 7, 10, 13].flatMap(x => ys.map(yy => img.at(img.width - 1 - x, yy))), 12);
  if (left.coverage >= 0.8 && right.coverage >= 0.8 && dist(left.color, right.color) <= 14) return { color: left.color, coverage: 1 };
  const mode = modeColor(pts, 6);
  // no flat colour anywhere in the row: a photo row; all photo rows share one marker so bands cut where photos start and end
  if (mode.coverage < 0.18 && left.coverage < 0.8 && right.coverage < 0.8) return { color: [999, 999, 999], coverage: 1 };
  if (mode.coverage >= 0.5) return mode;
  return left.coverage >= 0.8 ? { color: left.color, coverage: 0.6 } : mode;
}

// ---------- sections: rows whose dominant colour changes and stays changed ----------
function findBands(img) {
  const { width, height } = img;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const pts = [];
    for (let x = 0; x < width; x += 3) pts.push(img.at(x, y));
    rows.push(rowBackground(img, y, pts));
  }
  const bands = [], dividers = [];
  let start = 0, color = rows[0].color;
  for (let y = 1; y < height; y++) {
    const row = rows[y];
    if (row.coverage < 0.5 || dist(row.color, color) <= 10) continue;
    let run = 0;
    while (y + run < height && run < 24 && rows[y + run].coverage >= 0.5 && dist(rows[y + run].color, row.color) <= 10) run++;
    if (run < 6) {
      const back = y + run < height && dist(rows[y + run].color, color) <= 10;
      if (back) { dividers.push({ y, height: run, color: hex(row.color), coverage: r1(row.coverage) }); y += run - 1; continue; }
    }
    if (run >= 6 || y + run >= height) {
      if (y - start >= 16) bands.push([start, y]); else if (bands.length) bands.at(-1)[1] = y;
      start = y; color = row.color;
    }
  }
  bands.push([start, height]);
  // dividers that repeat every few rows are a texture, not rules
  const lone = dividers.filter(d => !dividers.some(o => o !== d && Math.abs(o.y - d.y) <= 12));
  return { bands: bands.filter(([a, b]) => b - a > 0), dividers: lone };
}

// A flat stand-in for a photo or gradient: average colours in five slices along the axis that varies most.
function colourStops(img, box) {
  const [x, y, w, h] = box;
  const slice = (horizontal, k) => {
    let sum = [0, 0, 0], n = 0;
    const stepX = Math.max(1, Math.floor(w / 40)), stepY = Math.max(1, Math.floor(h / 40));
    for (let yy = y; yy < y + h; yy += stepY) for (let xx = x; xx < x + w; xx += stepX) {
      const t = horizontal ? (xx - x) / w : (yy - y) / h;
      if (Math.floor(t * 5) !== k) continue;
      const c = img.at(xx, yy); sum = sum.map((v, i) => v + c[i]); n++;
    }
    return n ? sum.map(v => v / n) : [0, 0, 0];
  };
  const across = [0, 1, 2, 3, 4].map(k => slice(true, k)), down = [0, 1, 2, 3, 4].map(k => slice(false, k));
  const range = cs => Math.max(...[0, 1, 2].map(i => Math.max(...cs.map(c => c[i])) - Math.min(...cs.map(c => c[i]))));
  const horizontal = range(across) > range(down);
  return { direction: horizontal ? 'to right' : 'to bottom', colors: (horizontal ? across : down).map(hex) };
}

function bandBackground(img, y0, y1) {
  const pts = [];
  const stepY = Math.max(1, Math.floor((y1 - y0) / 40)), stepX = Math.max(1, Math.floor(img.width / 60));
  for (let y = y0; y < y1; y += stepY) for (let x = 0; x < img.width; x += stepX) pts.push(img.at(x, y));
  // both page edges one flat colour: that is the background, whatever sits in the middle
  const edgePts = [];
  for (let y = y0; y < y1; y += stepY) for (const x of [2, 8, img.width - 9, img.width - 3]) edgePts.push(img.at(x, y));
  const edgeMode = modeColor(edgePts, 16);
  if (edgeMode.coverage >= 0.7) return { kind: 'flat', color: edgeMode.color };
  const mode = modeColor(pts, 8);
  if (mode.coverage >= 0.4) return { kind: 'flat', color: mode.color };
  const edge = (xs, ys) => hex(modeColor(xs.flatMap(x => ys.map(y => img.at(x, y))), 8).color);
  const mid = Math.floor((y0 + y1) / 2), W = img.width - 1;
  const stops = colourStops(img, [0, y0, img.width, y1 - y0]);
  const meanOf = ps => ps.reduce((a, c) => a.map((v, i) => v + c[i]), [0, 0, 0]).map(v => v / Math.max(1, ps.length));
  const half = edgePts.length / 2;
  const leftMean = meanOf(edgePts.filter((_, i) => i % 4 < 2)), rightMean = meanOf(edgePts.filter((_, i) => i % 4 >= 2));
  // symmetric edges (margins, texture): their average; otherwise (split banner) the band's commonest colour
  const edgeMean = dist(leftMean, rightMean) <= 20 ? meanOf(edgePts) : mode.color;
  return { kind: 'mixed', color: mode.color, edgeMean: hex(edgeMean), top: edge([0, W >> 2, W >> 1, (3 * W) >> 2, W], [y0, y0 + 1]),
    bottom: edge([0, W >> 2, W >> 1, (3 * W) >> 2, W], [y1 - 1, y1 - 2]), left: edge([0, 1], [y0, mid, y1 - 1]), right: edge([W, W - 1], [y0, mid, y1 - 1]), gradient: stops };
}

// ---------- OCR: three passes in parallel, merged word by word ----------
async function readTextLines(source, width, language) {
  // a flattened, re-encoded PNG reads noticeably better than some original files (alpha, colour profiles)
  const grey = await sharp(source).flatten({ background: '#ffffff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const local = await sharp(grey.data, { raw: { width: grey.info.width, height: grey.info.height, channels: 1 } }).blur(12).raw().toBuffer();
  const norm = Buffer.alloc(grey.data.length);
  for (let i = 0; i < norm.length; i++) norm[i] = local[i] < 118 ? 255 - grey.data[i] : grey.data[i];
  const flat = await sharp(norm, { raw: { width: grey.info.width, height: grey.info.height, channels: 1 } }).png().toBuffer();
  const original = await sharp(source).flatten({ background: '#ffffff' }).removeAlpha().png().toBuffer();
  const big = await sharp(flat).resize({ width: width * 2 }).png().toBuffer();
  const passes = await Promise.all([
    recognizeText(flat, { language, minConfidence: 0, pageSegMode: 3 }),
    recognizeText(flat, { language, minConfidence: 0, pageSegMode: 11 }),
    recognizeText(original, { language, minConfidence: 0, pageSegMode: 3 }),
    recognizeText(big, { language, minConfidence: 0, pageSegMode: 11 }).then(r => ({ ...r, words: r.words.map(w => ({ ...w, bounds: w.bounds.map(v => Math.round(v / 2)) })) })),
  ]);
  const alnum = t => (t.match(/[A-Za-z0-9]/g) || []).length;
  const trimWords = ws => { let a = 0, b = ws.length; while (a < b && !alnum(ws[a].text)) a++; while (b > a && !alnum(ws[b - 1].text)) b--; return ws.slice(a, b); };
  const overlap = (a, b) => {
    const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
    const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    return x * y / Math.min(a[2] * a[3], b[2] * b[3]);
  };
  // lines are built inside each pass, so their words agree in scale; then whole lines are merged
  const all = [];
  for (const pass of passes) {
    const words = pass.words.filter(w => w.bounds[2] > 1 && w.bounds[3] > 3 && (alnum(w.text) >= 1 ? w.confidence >= 0.35 : /^[—–\-•·|/&@+:]+$/.test(w.text)))
      .sort((a, b) => a.bounds[0] - b.bounds[0]);
    const lines = [];
    for (const w of words) {
      const [x, y, , h] = w.bounds, cy = y + h / 2;
      const line = lines.find(l => {
        const last = l.words.at(-1), [lx, ly, lw, lh] = last.bounds;
        const gap = x - (lx + lw), hh = Math.max(h, lh);
        return Math.abs(cy - (ly + lh / 2)) <= 0.4 * hh && h / lh > 0.55 && h / lh < 1.8 && gap >= -3 && gap <= Math.max(12, 1.1 * hh);
      });
      if (line) line.words.push(w); else lines.push({ words: [w] });
    }
    for (const l of lines) {
      l.words = trimWords(l.words);
      if (!l.words.length) continue;
      const text = l.words.map(w => w.text).join(' ');
      const confidence = l.words.reduce((s, w) => s + w.confidence * alnum(w.text), 0) / Math.max(1, alnum(text));
      if (alnum(text) >= 2 ? confidence >= 0.55 : confidence >= 0.85) all.push({ text, bounds: union(l.words.map(w => w.bounds)), confidence, score: confidence * Math.sqrt(alnum(text)) });
    }
  }
  // primary: the default pass keeps Tesseract's own lines (all their words, punctuation included), split at column gaps
  const primary = [];
  for (const pass of [passes[0], passes[3]]) for (const line of pass.lines.filter(l => l.confidence >= 0.5)) {
    const inLine = pass.words.filter(w => { const cx = w.bounds[0] + w.bounds[2] / 2, cy = w.bounds[1] + w.bounds[3] / 2;
      return cx >= line.bounds[0] && cx <= line.bounds[0] + line.bounds[2] && cy >= line.bounds[1] && cy <= line.bounds[1] + line.bounds[3]; })
      .sort((a, b) => a.bounds[0] - b.bounds[0]);
    let piece = [];
    const flush = () => {
      piece = trimWords(piece);
      if (!piece.length) return;
      const text = piece.map(w => w.text).join(' ');
      const confidence = piece.reduce((s, w) => s + w.confidence * alnum(w.text), 0) / Math.max(1, alnum(text));
      if (alnum(text) >= 2 && confidence >= 0.45) primary.push({ text, bounds: union(piece.map(w => w.bounds)), confidence, score: confidence * Math.sqrt(alnum(text)) });
      piece = [];
    };
    // Tesseract sometimes puts two table rows in one line; separate rows by vertical centre first
    const rows = [];
    for (const w of inLine) {
      const cy = w.bounds[1] + w.bounds[3] / 2;
      const row = rows.find(r => Math.abs(r.cy - cy) <= 0.5 * Math.max(r.h, w.bounds[3]));
      if (row) row.words.push(w); else rows.push({ cy, h: w.bounds[3], words: [w] });
    }
    for (const row of rows) {
      for (const w of row.words) {
        const last = piece.at(-1);
        if (last && w.bounds[0] - (last.bounds[0] + last.bounds[2]) > Math.max(14, 1.6 * Math.max(w.bounds[3], last.bounds[3]))) flush();
        piece.push(w);
      }
      flush();
    }
  }
  const kept = [];
  for (const l of primary.sort((a, b) => b.score - a.score)) if (!kept.some(k => overlap(k.bounds, l.bounds) > 0.3)) kept.push(l);
  for (const l of all.sort((a, b) => b.score - a.score)) if (!kept.some(k => overlap(k.bounds, l.bounds) > 0.2)) kept.push(l);
  return kept;
}

// ---------- text lines: OCR words -> measured colour and tight ink box ----------
function measureText(img, line) {
  const { width: W, height: H } = img;
  const box = grow(line.bounds, 2, W, H);
  const ring = [];
  const outer = grow(line.bounds, 5, W, H);
  for (let x = outer[0]; x < outer[0] + outer[2]; x++) { ring.push(img.at(x, outer[1])); ring.push(img.at(x, outer[1] + outer[3] - 1)); }
  for (let y = outer[1]; y < outer[1] + outer[3]; y++) { ring.push(img.at(outer[0], y)); ring.push(img.at(outer[0] + outer[2] - 1, y)); }
  const ringMode = modeColor(ring, 8), bg = line.bgOverride || ringMode.color;
  // background per column (above/below the text), so text over a split or varied background is measured against what is behind it
  const colBg = [];
  for (let x = box[0]; x < box[0] + box[2]; x++) {
    const pts = [];
    for (let k = Math.max(outer[0], x - 3); k <= Math.min(outer[0] + outer[2] - 1, x + 3); k++) { pts.push(img.at(k, outer[1])); pts.push(img.at(k, outer[1] + outer[3] - 1)); }
    const m = modeColor(pts, 12);
    colBg.push(line.bgOverride || (m.coverage >= 0.5 ? m.color : bg));
  }
  const bgAt = x => colBg[x - box[0]] || bg;
  const ds = [];
  for (let y = box[1]; y < box[1] + box[3]; y++) for (let x = box[0]; x < box[0] + box[2]; x++) ds.push(dist(img.at(x, y), bgAt(x)));
  const sorted = [...ds].sort((a, b) => a - b);
  const maxd = sorted[Math.floor(sorted.length * 0.98)] || 0;
  if (maxd < 30) return null;
  // most of the "ink" is one flat colour: the text sits on a filled shape (button, badge, pill) that OCR's box
  // covered; measure the text against that fill and report the shape
  if (!line.bgOverride) {
    const inkPts = [];
    ds.forEach((d, i) => { if (d > maxd * 0.5) inkPts.push(img.at(box[0] + i % box[2], box[1] + Math.floor(i / box[2]))); });
    const fill = modeColor(inkPts, 12);
    if (process.env.I2C_DEBUG_FILL && /SUBSCRIBE/i.test(line.text)) console.error('fill?', line.text, line.bounds, (inkPts.length / ds.length).toFixed(2), fill.coverage.toFixed(2), fill.color, bg);
    if (inkPts.length > 0.55 * ds.length && fill.coverage >= 0.5) {
      let fx0 = W, fy0 = H, fx1 = -1, fy1 = -1;
      const scan = grow(line.bounds, Math.round(line.bounds[3] * 0.6), W, H);
      for (let y = scan[1]; y < scan[1] + scan[3]; y++) for (let x = scan[0]; x < scan[0] + scan[2]; x++)
        if (dist(img.at(x, y), fill.color) <= 14) { fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); fy0 = Math.min(fy0, y); fy1 = Math.max(fy1, y); }
      // measure the text only inside the shape (the page around it is not text)
      const fb = [fx0 + 3, fy0 + 3, fx1 - fx0 - 5, fy1 - fy0 - 5];
      const ib = [Math.max(line.bounds[0], fb[0]), Math.max(line.bounds[1], fb[1])];
      const ie = [Math.min(line.bounds[0] + line.bounds[2], fb[0] + fb[2]), Math.min(line.bounds[1] + line.bounds[3], fb[1] + fb[3])];
      const inner = fx1 > fx0 && ie[0] - ib[0] > 4 && ie[1] - ib[1] > 4 ? measureText(img, { ...line, bounds: [ib[0], ib[1], ie[0] - ib[0], ie[1] - ib[1]], bgOverride: fill.color }) : null;
      if (inner) { inner.fillBox = [fx0, fy0, fx1 - fx0 + 1, fy1 - fy0 + 1]; inner.fillColor = fill.color; return inner; }
    }
  }
  let minX = W, minY = H, maxX = -1, maxY = -1;
  const core = [];
  ds.forEach((d, i) => {
    if (d <= maxd * 0.5) return;
    const x = box[0] + i % box[2], y = box[1] + Math.floor(i / box[2]);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    if (d >= maxd * 0.75) core.push(img.at(x, y));
  });
  if (maxX < 0) return null;
  // keep only the block of ink rows that contains the OCR line's centre (a neighbouring line's descenders stay out)
  {
    const rowInk = new Array(box[3]).fill(0);
    ds.forEach((d, i) => { if (d > maxd * 0.5) rowInk[Math.floor(i / box[2])]++; });
    const centre = clamp(Math.round(line.bounds[1] + line.bounds[3] / 2) - box[1], 0, box[3] - 1);
    let a = centre, b = centre;
    while (a > 0 && (rowInk[a - 1] > 0 || (a > 1 && rowInk[a - 2] > 0))) a--;
    while (b < box[3] - 1 && (rowInk[b + 1] > 0 || (b < box[3] - 2 && rowInk[b + 2] > 0))) b++;
    // stay within the rows OCR placed this line on (lines set close together touch through ascenders/descenders)
    const pad = Math.max(3, Math.round(line.bounds[3] * 0.3));
    a = Math.max(a, line.bounds[1] - pad - box[1]); b = Math.min(b, line.bounds[1] + line.bounds[3] + pad - box[1]);
    if (a > minY - box[1] || b < maxY - box[1]) {
      minX = W; maxX = -1; minY = H; maxY = -1;
      ds.forEach((d, i) => { const ry = Math.floor(i / box[2]); if (d <= maxd * 0.5 || ry < a || ry > b) return;
        const x = box[0] + i % box[2], y = box[1] + ry; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); });
      if (maxX < 0) return null;
    }
  }
  const tight = [minX, minY, maxX - minX + 1, maxY - minY + 1];
  // per channel, the extreme value inside the strokes (towards the text colour): cancels coloured
  // sub-pixel fringes and partial coverage of thin strokes
  const ink = [0, 1, 2].map(ch => {
    const vals = core.map(c => c[ch]).sort((a, b) => a - b);
    if (!vals.length) return bg[ch];
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return mean < bg[ch] ? vals[Math.floor(vals.length * 0.2)] : vals[Math.ceil(vals.length * 0.8) - 1];
  });
  const mask = new Uint8Array(tight[2] * tight[3]), gray = new Uint8Array(tight[2] * tight[3]);
  let on = 0;
  let inkSum = 0;
  for (let y = 0; y < tight[3]; y++) for (let x = 0; x < tight[2]; x++) {
    const d = dist(img.at(tight[0] + x, tight[1] + y), bgAt(tight[0] + x));
    gray[y * tight[2] + x] = clamp(Math.round(255 * d / maxd), 0, 255);
    inkSum += Math.min(1, d / Math.max(maxd, dist(ink, bg)));
    if (d > maxd * 0.5) { mask[y * tight[2] + x] = 1; on++; }
  }
  // baseline: the lowest row that still carries a solid share of the ink (descenders are sparse)
  const rows = new Array(tight[3]).fill(0);
  for (let y = 0; y < tight[3]; y++) for (let x = 0; x < tight[2]; x++) rows[y] += mask[y * tight[2] + x];
  const peak = Math.max(...rows);
  let base = tight[3] - 1;
  while (base > 0 && rows[base] < 0.35 * peak) base--;
  let xTop = base;
  while (xTop > 0 && rows[xTop - 1] >= 0.3 * peak) xTop--;
  return { text: line.text, ocrBox: line.bounds, box: tight, color: ink, bg, bgCoverage: ringMode.coverage, confidence: line.confidence,
    mask, gray, coverage: on / mask.length, inkMean: inkSum / mask.length, baseline: tight[1] + base + 1, xHeight: base + 1 - xTop };
}

// An icon in front of a text line is often read by OCR as junk ("RQ,", "©"). Split it off.
function splitLeadingIcon(img, l) {
  const tokens = l.text.trim().split(/\s+/);
  if (tokens.length < 2) return null;
  const first = tokens[0];
  if (first.length > 4 || /\d/.test(first) || /^[A-Za-z][a-z]+[,.;:!?]?$/.test(first)) return null;
  const [x0, y0, w, h] = l.box;
  const cols = new Array(w).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cols[x] += l.mask[y * w + x];
  let x = 0;
  while (x < w && !cols[x]) x++;
  let end = x, gap = 0;
  while (end < w) { if (cols[end]) gap = 0; else if (++gap >= Math.max(6, 0.55 * h)) break; end++; }
  if (end >= w) return null;
  const clusterEnd = end - gap + 1, cw = clusterEnd - x;
  if (cw > 1.6 * h || cw < 0.4 * h) return null;
  let next = end;
  while (next < w && !cols[next]) next++;
  if (next >= w) return null;
  let top = h, bottom = -1;
  for (let y = 0; y < h; y++) for (let c = x; c < clusterEnd; c++) if (l.mask[y * w + c]) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  const restBounds = [x0 + next, y0, x0 + w - (x0 + next), h];
  return { icon: [x0 + x, y0 + top, cw, bottom - top + 1], rest: { text: tokens.slice(1).join(' '), bounds: restBounds, confidence: l.confidence } };
}

// ---------- flat regions (boxes, inputs, buttons, cards) and thin rules ----------
function flatRegions(img, minArea = 300) {
  const { width: W, height: H, data } = img;
  const labels = new Int32Array(W * H).fill(-1);
  const stack = new Int32Array(W * H);
  const regions = [];
  for (let start = 0; start < W * H; start++) {
    if (labels[start] !== -1) continue;
    const id = regions.length;
    const s = start * 3, seed = [data[s], data[s + 1], data[s + 2]];
    let top = 0, area = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    const sum = [0, 0, 0];
    stack[top++] = start; labels[start] = id;
    while (top) {
      const p = stack[--top];
      const x = p % W, y = (p - x) / W, o = p * 3;
      area++; sum[0] += data[o]; sum[1] += data[o + 1]; sum[2] += data[o + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const near = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const n of near) {
        if (n < 0 || labels[n] !== -1) continue;
        const q = n * 3;
        if (Math.abs(data[q] - seed[0]) <= 10 && Math.abs(data[q + 1] - seed[1]) <= 10 && Math.abs(data[q + 2] - seed[2]) <= 10) {
          labels[n] = id; stack[top++] = n;
        }
      }
    }
    regions.push(area >= minArea || (area >= 30 && (x1 - x0 + 1 >= 30 || y1 - y0 + 1 >= 30))
      ? { id, area, box: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], color: sum.map(v => v / area) } : null);
  }
  return { labels, regions: regions.filter(Boolean) };
}

// Edge segments survive the colour noise of generated images better than flat-colour regions.
function edgeSegments(img, T = 14) {
  const { width: W, height: H, data } = img;
  const diff = (p, q) => Math.max(Math.abs(data[p] - data[q]), Math.abs(data[p + 1] - data[q + 1]), Math.abs(data[p + 2] - data[q + 2]));
  const hs = [], vs = [];
  for (let y = 1; y < H; y++) {
    let start = -1, gap = 0;
    for (let x = 0; x <= W; x++) {
      const on = x < W && diff((y * W + x) * 3, ((y - 1) * W + x) * 3) > T;
      if (on) { if (start < 0) start = x; gap = 0; }
      else if (start >= 0 && ++gap > 2) { const end = x - gap; if (end - start + 1 >= 24) hs.push({ y, x0: start, x1: end }); start = -1; gap = 0; }
    }
  }
  for (let x = 1; x < W; x++) {
    let start = -1, gap = 0;
    for (let y = 0; y <= H; y++) {
      const on = y < H && diff((y * W + x) * 3, (y * W + x - 1) * 3) > T;
      if (on) { if (start < 0) start = y; gap = 0; }
      else if (start >= 0 && ++gap > 2) { const end = y - gap; if (end - start + 1 >= 16) vs.push({ x, y0: start, y1: end }); start = -1; gap = 0; }
    }
  }
  return { hs, vs };
}

function edgeRects(img, hs, vs, avoid) {
  const { width: W, height: H } = img;
  const rects = [];
  const near = (a, b, t) => Math.abs(a - b) <= t;
  for (const top of hs) for (const bottom of hs) {
    const dy = bottom.y - top.y;
    if (dy < 14 || dy > 900) continue;
    const tol = Math.max(5, 0.02 * (top.x1 - top.x0));
    if (!near(top.x0, bottom.x0, tol + 6) || !near(top.x1, bottom.x1, tol + 6)) continue;
    const x0 = Math.min(top.x0, bottom.x0), x1 = Math.max(top.x1, bottom.x1);
    const side = x => {
      const near8 = vs.filter(v => near(v.x, x, 6) && v.y1 >= top.y - 2 && v.y0 <= bottom.y + 2);
      const cover = near8.reduce((sum, v) => sum + Math.max(0, Math.min(v.y1, bottom.y) - Math.max(v.y0, top.y)), 0);
      const corner = Math.max(8, Math.min(24, dy * 0.25));
      return cover >= 0.7 * dy && near8.some(v => v.y0 <= top.y + corner) && near8.some(v => v.y1 >= bottom.y - corner);
    };
    if (!side(x0) || !side(x1 + 1)) continue;
    if (hs.some(m => m.y > top.y + 3 && m.y < bottom.y - 3 && near(m.x0, x0, tol + 4) && near(m.x1, x1, tol + 4))) continue;
    const box = [x0, top.y, x1 - x0 + 1, dy];
    const inner = grow(box, -4, W, H);
    if (inner[2] < 4 || inner[3] < 4) continue;
    const pts = [];
    for (let fy = 0.1; fy < 0.95; fy += 0.1) for (let fx = 0.05; fx < 0.98; fx += 0.05) {
      const p = [Math.round(inner[0] + inner[2] * fx), Math.round(inner[1] + inner[3] * fy)];
      if (!avoid.some(a => p[0] >= a[0] && p[0] < a[0] + a[2] && p[1] >= a[1] && p[1] < a[1] + a[3])) pts.push(img.at(p[0], p[1]));
    }
    if (pts.length < 6) continue;
    const mode = modeColor(pts, 8);
    // grainy but evenly coloured (dark wood, linen, sky): still a photo; text areas are left out of the measure
    if (mode.coverage >= 0.6 && inner[2] >= 100 && inner[3] >= 80 && grain(img, inner, avoid) >= 0.06) { rects.push({ box, fill: mode.color, photo: true }); continue; }
    if (mode.coverage < 0.6) {
      // a smooth interior is a gradient card, not a photo
      const sharp = inner[2] >= 40 && inner[3] >= 30 ? grain(img, inner, avoid) : 1;
      if (sharp < 0.04) rects.push({ box, fill: mode.color, gradient: colourStops(img, inner) });
      // a crisp rectangle with a textured inside is a photo frame
      else if (inner[2] >= 60 && inner[3] >= 60) rects.push({ box, fill: mode.color, photo: true });
      continue;
    }
    rects.push({ box, fill: mode.color });
  }
  // keep the tightest rectangle for each top edge, drop near duplicates
  rects.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
  const out = [];
  for (const r of rects) if (!out.some(o => Math.abs(o.box[0] - r.box[0]) <= 4 && Math.abs(o.box[1] - r.box[1]) <= 4 && Math.abs(o.box[2] - r.box[2]) <= 8 && Math.abs(o.box[3] - r.box[3]) <= 8)) out.push(r);
  return out;
}

function lineBorder(img, box, fill) {
  // a thin border shows as a band at each side whose colour differs from both the fill and the outside
  const { width: W, height: H } = img;
  const sample = (x, y) => img.at(clamp(x, 0, W - 1), clamp(y, 0, H - 1));
  const sides = { top: [], bottom: [], left: [], right: [] };
  for (const f of [0.25, 0.5, 0.75]) {
    const x = Math.round(box[0] + box[2] * f), y = Math.round(box[1] + box[3] * f);
    sides.top.push([-1, 0, 1, 2].map(k => sample(x, box[1] + k)));
    sides.bottom.push([-1, 0, 1, 2].map(k => sample(x, box[1] + box[3] - 1 - k)));
    sides.left.push([-2, -1, 0, 1, 2].map(k => sample(box[0] + k, y)));
    sides.right.push([-2, -1, 0, 1, 2].map(k => sample(box[0] + box[2] - 1 - k, y)));
  }
  const found = {};
  for (const [side, rows] of Object.entries(sides)) {
    const cands = rows.map(r => r.reduce((best, c) => dist(c, fill) > dist(best, fill) ? c : best, r[0]));
    if (cands.every(c => dist(c, fill) > 14)) found[side] = hex(modeColor(cands, 12).color);
  }
  const vals = Object.values(found);
  if (vals.length === 4 && vals.every(v => dist([1, 3, 5].map(k => parseInt(v.slice(k, k + 2), 16)), [1, 3, 5].map(k => parseInt(vals[0].slice(k, k + 2), 16))) <= 16))
    return `1px solid ${vals[0]}`;
  if (vals.length) return Object.fromEntries(Object.entries(found).map(([k, v]) => [k, `1px solid ${v}`]));
  return null;
}

function mergeRules(rules) {
  const out = [];
  for (const r of [...rules].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
    const horizontal = r.box[3] <= 3;
    const prev = out.find(o => (o.box[3] <= 3 || o.box[2] <= 3) === true && (horizontal
      ? o.horizontal && Math.abs(o.box[0] - r.box[0]) <= 3 && Math.abs(o.box[0] + o.box[2] - r.box[0] - r.box[2]) <= 3 && r.box[1] <= o.box[1] + o.box[3] + 1
      : !o.horizontal && Math.abs(o.box[1] - r.box[1]) <= 3 && Math.abs(o.box[1] + o.box[3] - r.box[1] - r.box[3]) <= 3 && r.box[0] <= o.box[0] + o.box[2] + 1 && r.box[0] >= o.box[0]));
    if (prev) { prev.box = union([prev.box, r.box]); prev.parts.push(r); }
    else out.push({ box: [...r.box], horizontal, parts: [r] });
  }
  return out;
}

function standaloneRule(img, rule) {
  const { width: W, height: H } = img;
  const [x, y, w, h] = rule.box;
  let good = 0;
  const pts = [0.15, 0.35, 0.5, 0.65, 0.85];
  for (const f of pts) {
    const px = rule.horizontal ? Math.round(x + w * f) : x, py = rule.horizontal ? y : Math.round(y + h * f);
    const a = rule.horizontal ? img.at(px, clamp(y - 2, 0, H - 1)) : img.at(clamp(x - 2, 0, W - 1), py);
    const b = rule.horizontal ? img.at(px, clamp(y + h + 1, 0, H - 1)) : img.at(clamp(x + w + 1, 0, W - 1), py);
    if (dist(rule.color, a) > 15 && dist(rule.color, b) > 15 && dist(a, b) <= 14) good++;
  }
  return good >= 4;
}

function interiorFill(img, box, avoid) {
  const pts = [];
  for (let fy = 0.15; fy < 0.9; fy += 0.1) for (let fx = 0.05; fx < 0.96; fx += 0.05) {
    const p = [Math.round(box[0] + box[2] * fx), Math.round(box[1] + box[3] * fy)];
    if (!avoid.some(a => p[0] >= a[0] && p[0] < a[0] + a[2] && p[1] >= a[1] && p[1] < a[1] + a[3])) pts.push(img.at(p[0], p[1]));
  }
  return modeColor(pts.length ? pts : [img.at(box[0] + (box[2] >> 1), box[1] + (box[3] >> 1))], 6).color;
}

function boxStyle(img, box, fill) {
  const { width: W, height: H } = img;
  const [x, y, w, h] = box;
  const sides = {};
  const sample = (px, py) => img.at(clamp(px, 0, W - 1), clamp(py, 0, H - 1));
  const probe = (points, step) => {
    const found = [];
    for (const [px, py] of points) {
      const c1 = sample(px + step[0], py + step[1]);
      let width = 1;
      while (width < 4 && dist(sample(px + step[0] * (width + 1), py + step[1] * (width + 1)), c1) <= 10) width++;
      const outer = sample(px + step[0] * (width + 3), py + step[1] * (width + 3));
      const between = dist(c1, fill) + dist(c1, outer) <= dist(fill, outer) + 10;
      if (dist(c1, fill) > 12 && dist(c1, outer) > 8 && !between) found.push({ c1, width });
    }
    if (found.length < Math.ceil(points.length * 0.8)) return null;
    return { color: hex(found[0].c1), width: median(found.map(f => f.width)) };
  };
  const xs = [0.2, 0.35, 0.5, 0.65, 0.8].map(f => Math.round(x + w * f));
  const ys = [0.25, 0.5, 0.75].map(f => Math.round(y + h * f));
  sides.top = probe(xs.map(px => [px, y]), [0, -1]);
  sides.bottom = probe(xs.map(px => [px, y + h - 1]), [0, 1]);
  sides.left = probe(ys.map(py => [x, py]), [-1, 0]);
  sides.right = probe(ys.map(py => [x + w - 1, py]), [1, 0]);
  const radii = [[x, y, 1, 1], [x + w - 1, y, -1, 1], [x, y + h - 1, 1, -1], [x + w - 1, y + h - 1, -1, -1]].map(([cx, cy, dx, dy]) => {
    let k = 0;
    while (k < Math.min(w, h) / 2 && dist(sample(cx + dx * k, cy + dy * k), fill) > 12) k++;
    return k;
  });
  const radius = Math.round(median(radii) * 3.41);
  let border = null;
  const set = Object.entries(sides).filter(([, v]) => v);
  if (set.length === 4 && set.every(([, v]) => v.color === set[0][1].color)) border = `${set[0][1].width}px solid ${set[0][1].color}`;
  else if (set.length) border = Object.fromEntries(set.map(([k, v]) => [k, `${v.width}px solid ${v.color}`]));
  return { border, radius, borderWidth: set.length ? Math.max(...set.map(([, v]) => v.width)) : 0 };
}

// ---------- busy cells: images and icons, measured against the local background ----------
function busyComponents(img, localBg, ignore, cell = 6) {
  const { width: W, height: H } = img;
  const cw = Math.ceil(W / cell), ch = Math.ceil(H / cell);
  const busy = new Uint8Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    let count = 0, lo = [255, 255, 255], hi = [0, 0, 0], used = 0;
    for (let y = cy * cell; y < Math.min(H, cy * cell + cell); y++) for (let x = cx * cell; x < Math.min(W, cx * cell + cell); x++) {
      const p = y * W + x;
      if (ignore[p]) continue;
      const o = p * 3;
      used++;
      for (let c = 0; c < 3; c++) { if (img.data[o + c] < lo[c]) lo[c] = img.data[o + c]; if (img.data[o + c] > hi[c]) hi[c] = img.data[o + c]; }
      if (Math.max(Math.abs(img.data[o] - localBg[o]), Math.abs(img.data[o + 1] - localBg[o + 1]), Math.abs(img.data[o + 2] - localBg[o + 2])) > 28) count++;
    }
    // texture inside the cell, not a smooth shift of the background colour
    if (used >= 6 && count >= 2 && Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) > 24) busy[cy * cw + cx] = 1;
  }
  const seen = new Uint8Array(cw * ch), out = [];
  for (let i = 0; i < busy.length; i++) {
    if (!busy[i] || seen[i]) continue;
    const queue = [i]; seen[i] = 1;
    let x0 = cw, y0 = ch, x1 = -1, y1 = -1, cells = 0;
    while (queue.length) {
      const c = queue.pop(); cells++;
      const cx = c % cw, cy = (c - cx) / cw;
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const n = ny * cw + nx;
        if (busy[n] && !seen[n]) { seen[n] = 1; queue.push(n); }
      }
    }
    // refine to the pixels that actually differ
    const bx = x0 * cell, by = y0 * cell, bw = Math.min(W, (x1 + 1) * cell) - bx, bh = Math.min(H, (y1 + 1) * cell) - by;
    let mx0 = W, my0 = H, mx1 = -1, my1 = -1, ink = 0;
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
      const p = y * W + x;
      if (ignore[p]) continue;
      const o = p * 3;
      if (Math.max(Math.abs(img.data[o] - localBg[o]), Math.abs(img.data[o + 1] - localBg[o + 1]), Math.abs(img.data[o + 2] - localBg[o + 2])) > 28) {
        ink++; mx0 = Math.min(mx0, x); mx1 = Math.max(mx1, x); my0 = Math.min(my0, y); my1 = Math.max(my1, y);
      }
    }
    if (mx1 >= 0) out.push({ box: [mx0, my0, mx1 - mx0 + 1, my1 - my0 + 1], cells, ink });
  }
  return out;
}

// share of neighbouring pixel pairs that step by more than 2 levels, sampled outside the given boxes (photo grain)
function grain(img, box, avoid = []) {
  let steps = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.min(box[2], box[3]) / 80));
  for (let y = box[1]; y < box[1] + box[3]; y += step) for (let x = box[0]; x < box[0] + box[2] - 1; x += step) {
    if (avoid.some(a => x >= a[0] - 2 && x < a[0] + a[2] + 2 && y >= a[1] - 2 && y < a[1] + a[3] + 2)) continue;
    if (dist(img.at(x, y), img.at(x + 1, y)) > 2) steps++; n++;
  }
  return n ? steps / n : 0;
}

function sharpFraction(img, box, threshold = 10) {
  let sharp = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.min(box[2], box[3]) / 60));
  for (let y = box[1]; y < box[1] + box[3]; y += step) for (let x = box[0]; x < box[0] + box[2] - 1; x += step) {
    if (dist(img.at(x, y), img.at(x + 1, y)) > threshold) sharp++; n++;
  }
  return n ? sharp / n : 1;
}

function smoothness(img, box) {
  let total = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.min(box[2], box[3]) / 40));
  for (let y = box[1]; y < box[1] + box[3]; y += step) for (let x = box[0]; x < box[0] + box[2] - 1; x += step) {
    const a = img.at(x, y), b = img.at(x + 1, y);
    total += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); n++;
  }
  return n ? total / n / 3 : 0;
}

// ---------- fonts ----------
const acronyms = { dm: 'DM', eb: 'EB', ibm: 'IBM' };
export async function fontLibrary() {
  const root = path.dirname(path.dirname(require.resolve('@fontsource/inter/package.json')));
  const result = [];
  for (const dir of (await fs.readdir(root)).sort()) {
    const files = await fs.readdir(path.join(root, dir, 'files')).catch(() => []);
    const weights = files.map(f => f.match(new RegExp(`^${dir}-latin-(\\d+)-normal\\.woff2$`))).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b);
    if (!weights.length) continue;
    const name = dir.split('-').map(w => acronyms[w] || w[0].toUpperCase() + w.slice(1)).join(' ').replace(/ (\d)$/, ' $1');
    result.push({ id: dir, name, weights, file: w => path.join(root, dir, 'files', `${dir}-latin-${w}-normal.woff2`) });
  }
  return result;
}
const nearest = (weights, w) => weights.reduce((a, b) => Math.abs(b - w) < Math.abs(a - w) ? b : a);

async function launchBrowser() {
  const requested = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '');
  const executablePath = requested && await fs.access(requested).then(() => requested).catch(() => undefined);
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

// Runs inside the page. Kept as one function so it can be serialized.
async function fontWork({ faces, samples, stage }) {
  for (const f of faces) {
    const face = new FontFace(f.key, `url(${f.url})`);
    await face.load(); document.fonts.add(face);
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const metrics = (key, text, size) => {
    ctx.font = `${size}px "${key}"`; ctx.letterSpacing = '0px';
    const m = ctx.measureText(text);
    return { inkW: m.actualBoundingBoxLeft + m.actualBoundingBoxRight, inkH: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent, left: m.actualBoundingBoxLeft, ascent: m.actualBoundingBoxAscent,
      descent: m.actualBoundingBoxDescent, fontAscent: m.fontBoundingBoxAscent, fontDescent: m.fontBoundingBoxDescent };
  };
  const render = (key, text, size) => {
    const m = metrics(key, text, size);
    canvas.width = Math.max(1, Math.ceil(m.inkW) + 6); canvas.height = Math.max(1, Math.ceil(m.inkH) + 6);
    ctx.font = `${size}px "${key}"`; ctx.fillStyle = '#000'; ctx.fillText(text, m.left + 3, m.ascent + 3);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 127) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return null;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, bits = new Uint8Array(w * h);
    let on = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[((y + y0) * width + x + x0) * 4 + 3] > 127) { bits[y * w + x] = 1; on++; }
    let sum = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sum += data[((y + y0) * width + x + x0) * 4 + 3] / 255;
    return { w, h, bits, coverage: on / (w * h), inkMean: sum / (w * h) };
  };
  const iou = (a, b) => {
    let best = 0;
    const W = Math.max(a.w, b.w) + 2, H = Math.max(a.h, b.h) + 2;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      let inter = 0, uni = 0;
      for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
        const av = x >= 0 && y >= 0 && x < a.w && y < a.h ? a.bits[y * a.w + x] : 0;
        const bx = x - dx, by = y - dy;
        const bv = bx >= 0 && by >= 0 && bx < b.w && by < b.h ? b.bits[by * b.w + bx] : 0;
        if (av || bv) uni++; if (av && bv) inter++;
      }
      best = Math.max(best, uni ? inter / uni : 0);
    }
    return best;
  };
  const decode = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const clampI = (v, a, b) => v < a ? a : v > b ? b : v;
  const renderGray = (key, text, size, w, h) => {
    const m = metrics(key, text, size);
    canvas.width = Math.max(1, Math.ceil(m.inkW) + 6); canvas.height = Math.max(1, Math.ceil(m.inkH) + 6);
    ctx.font = `${size}px "${key}"`; ctx.fillStyle = '#000'; ctx.fillText(text, m.left + 3, m.ascent + 3);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 127) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return null;
    // stretch the render to the target box so the comparison sees letter shapes, not accumulated width drift
    const rw = x1 - x0 + 1, rh = y1 - y0 + 1, vals = new Float32Array(w * h);
    const alpha = (x, y) => data[((clampI(y, 0, rh - 1) + y0) * width + clampI(x, 0, rw - 1) + x0) * 4 + 3] / 255;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) * rw / w - 0.5, sy = (y + 0.5) * rh / h - 0.5;
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      vals[y * w + x] = alpha(ix, iy) * (1 - fx) * (1 - fy) + alpha(ix + 1, iy) * fx * (1 - fy) + alpha(ix, iy + 1) * (1 - fx) * fy + alpha(ix + 1, iy + 1) * fx * fy;
    }
    return { w, h, vals };
  };
  const cosine = (a, b) => {
    let best = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      let ab = 0, aa = 0, bb = 0;
      const W = Math.max(a.w, b.w + Math.abs(dx)), H = Math.max(a.h, b.h + Math.abs(dy));
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const av = x < a.w && y < a.h ? a.vals[y * a.w + x] : 0;
        const bx = x - dx, by = y - dy;
        const bv = bx >= 0 && by >= 0 && bx < b.w && by < b.h ? b.vals[by * b.w + bx] : 0;
        ab += av * bv; aa += av * av; bb += bv * bv;
      }
      best = Math.max(best, aa && bb ? ab / Math.sqrt(aa * bb) : 0);
    }
    return best;
  };
  const out = [];
  for (const s of samples) {
    const target = { w: s.w, h: s.h, bits: decode(s.mask) };
    const targetGray = { w: s.w, h: s.h, vals: Float32Array.from(decode(s.gray), v => v / 255) };
    const chars = Math.max(1, [...s.text].length - 1);
    if (stage === 1) {
      const letters = [...s.text].filter(c => /[A-Za-z]/.test(c));
      const lower = letters.length && letters.filter(c => c === c.toLowerCase()).length / letters.length >= 0.6;
      const rows = faces.map(f => {
        const m = metrics(f.key, s.text, 100);
        const size = 100 * s.h / m.inkH;
        const sizeW = 100 * s.w / m.inkW;
        // x-height is a strong family signal: the size it implies must match the size the width implies
        const xh = lower && s.xh >= 5 ? metrics(f.key, 'x', 100).ascent : 0;
        const xErr = xh ? Math.abs((100 * s.xh / xh) / sizeW - 1) : 0;
        return { family: f.family, weight: f.weight, key: f.key, size, wErr: Math.abs(m.inkW * size / 100 - s.w) / s.w, xErr };
      }).filter(r => Number.isFinite(r.size)).sort((a, b) => (a.wErr + a.xErr) - (b.wErr + b.xErr)).slice(0, 16);
      for (const r of rows) {
        const g = renderGray(r.key, s.text, r.size, s.w, s.h);
        r.shape = g ? cosine(targetGray, g) : 0;
        r.score = r.shape - 0.8 * r.wErr - 2.5 * r.xErr;
      }
      const sizeW = {};
      for (const f of faces) if (f.weight === f.regular) { const m = metrics(f.key, s.text, 100); sizeW[f.family] = 100 * s.w / m.inkW; }
      out.push({ top: rows.sort((a, b) => b.score - a.score).slice(0, 6).map(({ key, ...r }) => r), sizeW });
    } else if (stage === 3) {
      // font box metrics (what the browser uses to place a line): ascent/descent in em
      const m = metrics(faces.find(f => f.family === s.family && f.weight === s.weight).key, 'Hxg', 100);
      out.push({ ascent: m.fontAscent / 100, descent: m.fontDescent / 100 });
    } else {
      const options = faces.filter(f => f.family === s.family).map(f => {
        const m = metrics(f.key, s.text, 100);
        const sizeH = 100 * s.h / m.inkH;
        const widthH = m.inkW * sizeH / 100;
        const r = render(f.key, s.text, sizeH);
        const err = (r ? Math.abs(r.inkMean - s.inkMean) * 4 : 1) + Math.abs(widthH - s.w) / s.w;
        return { weight: f.weight, sizeH, widthH, inkW100: m.inkW, err };
      }).sort((a, b) => a.err - b.err);
      const best = options[0];
      const sizeW = 100 * s.w / best.inkW100;
      const bestFace = faces.find(f => f.family === s.family && f.weight === best.weight);
      const letters = [...s.text].filter(c => /[A-Za-z]/.test(c));
      const upper = letters.length ? letters.filter(c => c === c.toUpperCase()).length / letters.length : 0;
      let size = chars >= 3 && !s.partial ? sizeW : best.sizeH, spacing = 0;
      // tracked caps (eyebrows, wordmarks): height gives the size, the extra width is letter spacing
      if (!s.partial && upper >= 0.6 && chars >= 3 && best.sizeH < sizeW * 0.9) { size = best.sizeH; spacing = (s.w - best.widthH) / chars; }
      // large display text: glyph height is measured precisely, so a width mismatch means tracking, not size
      else if (!s.partial && s.h >= 28 && chars >= 6 && Math.abs(best.sizeH / sizeW - 1) > 0.05 && Math.abs((s.w - best.widthH) / chars) <= 0.06 * best.sizeH) { size = best.sizeH; spacing = (s.w - best.widthH) / chars; }
      const m = metrics(bestFace.key, s.text, size);
      // origin: where CSS puts the start of the line so the first glyph's ink lands on the measured left edge
      out.push({ weight: best.weight, size, spacing, originOffset: m.left, sizeH: best.sizeH, sizeW });
    }
  }
  return out;
}

const familyClass = id => /mono|cousine|code/.test(id) ? 'mono' : /serif|tinos|gelasio|merriweather|playfair|lora|garamond|baskerville|crimson|cormorant|bodoni|slab|volkhov/.test(id) && !/sans/.test(id) ? 'serif' : 'sans';
const CLASS_MARGIN = Number(process.env.I2C_CLASS_MARGIN ?? 0.06);

async function fitFonts(lines, library) {
  if (!lines.length) return { families: [] };
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body></body></html>');
    const dataUrl = async file => `data:font/woff2;base64,${(await fs.readFile(file)).toString('base64')}`;
    // page text renders darker than canvas text; calibrated on the facts audit (weight within one step)
    const INK_FACTOR = Number(process.env.I2C_INK_FACTOR || 0.7);
    const encode = l => ({ inkMean: l.inkMean * INK_FACTOR, xh: l.xHeight, partial: Boolean(l.partial), text: l.text, w: l.box[2], h: l.box[3], mask: Buffer.from(l.mask).toString('base64'), gray: Buffer.from(l.gray).toString('base64'), coverage: l.coverage });
    // stage 1: choose families on a sample of large and long lines
    const heights = lines.map(l => l.box[3]);
    const body = median(heights);
    const usable = lines.filter(l => !l.partial && l.confidence >= 0.75 && [...l.text].filter(c => /[A-Za-z]/.test(c)).length >= 3);
    const picked = new Set([...usable].sort((a, b) => b.box[3] - a.box[3]).slice(0, 8));
    for (const l of [...usable].sort((a, b) => b.text.length - a.text.length)) { if (picked.size >= 16) break; picked.add(l); }
    const byBlock = new Map();
    for (const l of usable) if (l.blockIndex != null) byBlock.set(l.blockIndex, [...(byBlock.get(l.blockIndex) || []), l]);
    for (const group of [...byBlock.values()].filter(g => g.length >= 2).sort((a, b) => b.length - a.length).slice(0, 4))
      for (const l of group.slice(0, 4)) if (picked.size < 28) picked.add(l);
    const samples = [...picked];
    const faces1 = [];
    for (const f of library) for (const w of new Set([nearest(f.weights, 300), nearest(f.weights, 400), nearest(f.weights, 700)]))
      faces1.push({ key: `f${faces1.length}`, family: f.id, weight: w, regular: nearest(f.weights, 400), url: await dataUrl(f.file(w)) });
    const stage1 = samples.length ? await page.evaluate(fontWork, { faces: faces1, samples: samples.map(encode), stage: 1 }) : [];
    // every paragraph gets its own shape evidence: one line from each block not sampled yet
    const sampledBlocks = new Set(samples.map(l => l.blockIndex));
    const extra = [...byBlock.values()].filter(g => !sampledBlocks.has(g[0].blockIndex))
      .map(g => [...g].sort((a, b) => b.text.length - a.text.length)[0]).sort((a, b) => b.text.length - a.text.length).slice(0, 24);
    const stage1x = extra.length ? await page.evaluate(fontWork, { faces: faces1, samples: extra.map(encode), stage: 1 }) : [];
    extra.forEach((l, i) => { l.fontCandidates = stage1x[i].top; });
    const ranked = stage1.map(r => r.top);
    // consistency: lines of one paragraph share a size, so in the true family their width-implied sizes agree
    const spread = family => {
      const groups = new Map();
      samples.forEach((l, i) => { if (l.blockIndex != null && stage1[i].sizeW[family]) groups.set(l.blockIndex, [...(groups.get(l.blockIndex) || []), stage1[i].sizeW[family]]); });
      const cvs = [...groups.values()].filter(v => v.length >= 2).map(v => { const m = v.reduce((a, b) => a + b, 0) / v.length;
        return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) / m; });
      return cvs.length ? { cv: cvs.reduce((a, b) => a + b, 0) / cvs.length, n: cvs.length } : null;
    };
    const display = l => l.box[3] >= body * 1.45;
    if (process.env.I2C_DEBUG_FONTS) samples.forEach((l, i) => console.error(l.text, l.box[3], JSON.stringify(ranked[i].map(r => `${r.family}/${r.weight} s${r.shape?.toFixed(2)} w${r.wErr.toFixed(2)} x${r.xErr.toFixed(2)}`))));
    const votes = { display: new Map(), body: new Map() };
    samples.forEach((l, i) => {
      l.fontCandidates = ranked[i];
      const seen = new Set();
      for (const r of ranked[i]) {
        if (seen.has(r.family)) continue; seen.add(r.family);
        const map = votes[display(l) ? 'display' : 'body'];
        if (l.box[3] < 12) continue;
        // the metric-compatible stand-ins for the default web fonts (Arial, Times, Georgia) get a small prior
        const prior = ['arimo', 'tinos', 'gelasio'].includes(r.family) ? 1.08 : 1;
        map.set(r.family, (map.get(r.family) || 0) + prior * Math.max(0, r.score) * Math.sqrt(l.text.length) * l.box[3]);
      }
    });
    const top = map => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    // among the best-voted body families, prefer the one whose paragraph lines agree on one size
    const bodyCands = [...votes.body.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f]) => ({ f, s: spread(f) })).filter(c => c.s);
    const voted = bodyCands[0];
    if (bodyCands.length >= 2) {
      const steadiest = [...bodyCands].sort((a, b) => a.s.cv - b.s.cv)[0];
      if (steadiest.s.cv < 0.8 * voted.s.cv) votes.body.set(steadiest.f, Infinity);
    }
    if (process.env.I2C_DEBUG_FONTS) console.error('consistency', JSON.stringify(bodyCands.map(c => [c.f, c.s.cv.toFixed(4)])));
    const bodyFamily = top(votes.body) || top(votes.display) || 'inter';
    const displayFamily = top(votes.display) || bodyFamily;
    // font class (sans / serif / mono) per paragraph from its own letter shapes; pages often mix classes, so the
    // page's body/display family only applies when its class agrees with the paragraph's
    const CLASSES = ['sans', 'serif', 'mono'];
    const classScores = l => { const out = { sans: -1, serif: -1, mono: -1 }; for (const r of l.fontCandidates || []) out[familyClass(r.family)] = Math.max(out[familyClass(r.family)], r.score); return out; };
    const blockClass = new Map();
    for (const l of lines) {
      if (!l.fontCandidates || l.blockIndex == null) continue;
      const acc = blockClass.get(l.blockIndex) || { sans: 0, serif: 0, mono: 0, n: 0 };
      const cs = classScores(l), w = Math.sqrt(l.text.length) * l.box[3];
      for (const c of CLASSES) acc[c] += Math.max(0, cs[c]) * w;
      acc.n += w; blockClass.set(l.blockIndex, acc);
    }
    const allVotes = new Map([...votes.body, ...votes.display].map(([f]) => [f, (votes.body.get(f) || 0) + (votes.display.get(f) || 0)]));
    const bestOfClass = (map, c) => [...map.entries()].filter(([f]) => familyClass(f) === c).sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const l of lines) {
      const group = display(l) ? displayFamily : bodyFamily;
      const other = group === displayFamily ? bodyFamily : displayFamily;
      const score = fam => l.fontCandidates?.find(r => r.family === fam)?.score ?? -1;
      l.family = l.box[3] >= 14 && score(other) > score(group) + 0.12 ? other : group;
      const acc = blockClass.get(l.blockIndex);
      if (!acc || !acc.n) continue;
      const want = CLASSES.reduce((a, b) => acc[b] > acc[a] ? b : a);
      const have = familyClass(l.family);
      if (want === have || (acc[want] - acc[have]) / acc.n < CLASS_MARGIN) continue;
      l.family = bestOfClass(votes[display(l) ? 'display' : 'body'], want) || bestOfClass(allVotes, want)
        || (l.fontCandidates || []).find(r => familyClass(r.family) === want)?.family || l.family;
    }
    // stage 2: weight, size and letter spacing for every line with its family
    const families = [...new Set(lines.map(l => l.family))];
    const faces2 = [];
    for (const id of families) { const f = library.find(x => x.id === id);
      for (const w of f.weights) faces2.push({ key: `g${faces2.length}`, family: id, weight: w, url: await dataUrl(f.file(w)) }); }
    const fitted = await page.evaluate(fontWork, { faces: faces2, samples: lines.map(l => ({ ...encode(l), family: l.family })), stage: 2 });
    lines.forEach((l, i) => Object.assign(l, { weight: fitted[i].weight, size: Math.round(fitted[i].size * 4) / 4, spacing: r1(fitted[i].spacing),
      originX: Math.round((l.box[0] + fitted[i].originOffset) * 10) / 10,
      sizeUnsure: !l.partial && l.box[3] < 28 && Math.abs(fitted[i].sizeH / fitted[i].sizeW - 1) > 0.12 }));
    const used = [...new Map(lines.map(l => [`${l.family}:${l.weight}`, { family: l.family, weight: l.weight }])).values()];
    const boxMetrics = await page.evaluate(fontWork, { faces: faces2, samples: used.map(u => ({ ...u, text: 'H', w: 1, h: 1, mask: '', gray: '' })), stage: 3 });
    const metrics = Object.fromEntries(used.map((u, i) => [`${u.family}:${u.weight}`, boxMetrics[i]]));
    return { families, displayFamily, bodyFamily, metrics };
  } finally { await browser.close(); }
}

// ---------- icons: shape match against Lucide ----------
async function lucideMasks() {
  const cacheFile = path.join(packageRoot, '.cache', 'lucide-32.json');
  const cached = await fs.readFile(cacheFile, 'utf8').then(JSON.parse).catch(() => null);
  if (cached) return cached.map(c => ({ name: c.name, bits: Uint8Array.from(Buffer.from(c.bits, 'base64')) }));
  const root = path.join(path.dirname(resolveDependency('lucide-static/package.json')), 'icons');
  const files = (await fs.readdir(root)).filter(f => f.endsWith('.svg'));
  const result = [];
  for (let i = 0; i < files.length; i += 32) await Promise.all(files.slice(i, i + 32).map(async file => {
    const svg = (await fs.readFile(path.join(root, file), 'utf8')).replace(/currentColor/g, '#000');
    const { data, info } = await sharp(Buffer.from(svg), { density: 200 }).resize(64, 64).flatten({ background: '#fff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const mask = new Uint8Array(info.width * info.height);
    for (let p = 0; p < mask.length; p++) mask[p] = data[p] < 140 ? 1 : 0;
    result.push({ name: file.slice(0, -4), bits: normalizeMask(mask, info.width, info.height) });
  }));
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(result.map(r => ({ name: r.name, bits: Buffer.from(r.bits).toString('base64') }))));
  return result;
}

function normalizeMask(mask, w, h, size = 32) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const out = new Uint8Array(size * size);
  if (x1 < 0) return out;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, scale = (size - 4) / Math.max(bw, bh);
  const ox = (size - bw * scale) / 2, oy = (size - bh * scale) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Math.floor((x - ox) / scale) + x0, sy = Math.floor((y - oy) / scale) + y0;
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1 && mask[sy * w + sx]) out[y * size + x] = 1;
  }
  // dilate once so stroke thickness matters less
  const d = new Uint8Array(out);
  for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) if (out[y * size + x]) { d[y * size + x - 1] = d[y * size + x + 1] = d[(y - 1) * size + x] = d[(y + 1) * size + x] = 1; }
  return d;
}

function matchIcon(bits, library) {
  return library.map(icon => {
    let inter = 0, uni = 0;
    for (let i = 0; i < bits.length; i++) { if (bits[i] || icon.bits[i]) uni++; if (bits[i] && icon.bits[i]) inter++; }
    return { name: icon.name, score: uni ? inter / uni : 0 };
  }).sort((a, b) => b.score - a.score).slice(0, 3);
}

// ---------- supplied originals ----------
async function thumb(input, box) {
  let p = sharp(input);
  if (box) p = p.extract({ left: box[0], top: box[1], width: box[2], height: box[3] });
  const { data } = await p.resize(16, 16, { fit: 'fill' }).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  return data;
}

// ---------- main ----------
export async function buildFacts({ screenshot, out, assetsDir, language = 'eng' }) {
  const started = performance.now();
  const times = {};
  const tick = (name, t0) => { times[name] = Math.round(performance.now() - t0); };
  const source = path.resolve(screenshot), dir = path.resolve(out);
  await fs.mkdir(dir, { recursive: true });
  for (const sub of ['assets', 'icons', 'sections']) await fs.mkdir(path.join(dir, sub), { recursive: true });

  let t0 = performance.now();
  const meta = await sharp(source).metadata();
  const [ocrLines, raw] = await Promise.all([
    readTextLines(source, meta.width, language),
    sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  tick('ocr', t0);
  const img = makeImage(raw.data, raw.info.width, raw.info.height);
  const { width: W, height: H } = img;

  t0 = performance.now();
  const lines = ocrLines.filter(l => l.bounds[3] < 260).map(l => measureText(img, l)).filter(Boolean);
  const splitIcons = [];
  for (let k = lines.length - 1; k >= 0; k--) {
    const split = splitLeadingIcon(img, lines[k]);
    if (!split) continue;
    const rest = measureText(img, split.rest);
    if (!rest) continue;
    splitIcons.push({ box: split.icon });
    lines[k] = rest;
  }
  const { bands, dividers: rowDividers } = findBands(img);
  // full-width photo sections: almost no flat colour across the band and both page edges changing colour.
  // Neighbouring photo bands (a photo is often cut into thin bands by its own colour changes) merge into one scene.
  const bandStats = bands.map(([a, b]) => {
    let flat = 0, n = 0;
    for (let y = a; y < b; y += 4) { const pts = []; for (let x = 0; x < W; x += 3) pts.push(img.at(x, y)); flat += modeColor(pts, 6).coverage; n++; }
    const range = x => { const lo = [255, 255, 255], hi = [0, 0, 0]; for (let y = a; y < b; y++) { const c = img.at(x, y); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c[k]); hi[k] = Math.max(hi[k], c[k]); } } return Math.max(...hi.map((h, k) => h - lo[k])); };
    const textBoxes = lines.map(l => l.box);
    const h = b - a;
    return { a, b, flat: flat / Math.max(1, n), left: range(6), right: range(W - 7),
      grain: grain(img, [0, a, W, h], textBoxes), grainL: grain(img, [0, a, Math.min(40, W), h], textBoxes), grainR: grain(img, [Math.max(0, W - 40), a, Math.min(40, W), h], textBoxes) };
  });
  if (process.env.I2C_DEBUG_SCENES) console.error(JSON.stringify(bandStats.map(b => [b.a, b.b, +b.flat.toFixed(2), b.left, b.right, +b.grain.toFixed(3), +b.grainL.toFixed(3), +b.grainR.toFixed(3)])));
  // little flat colour, or (dark overlays make a photo look uniform) photo grain across the band and at both page edges
  const photoBand = st => st.flat < 0.2 || (st.grain >= 0.06 && st.grainL >= 0.04 && st.grainR >= 0.04);
  const scenes = [];
  for (let k = 0; k < bandStats.length; k++) {
    if (!photoBand(bandStats[k])) continue;
    let e = k;
    while (e + 1 < bandStats.length && photoBand(bandStats[e + 1])) e++;
    const a = bandStats[k].a, b = bandStats[e].b;
    // a photo has texture; a smooth gradient background does not
    // photo grain survives soft focus and dark overlays (neighbour steps > 2 on ≥ 4% of pixels); CSS gradients stay near 1.6%
    if (b - a >= 60 && sharpFraction(img, [0, a, W, b - a], 2) >= 0.04) scenes.push([a, b]);
    k = e;
  }
  for (const [a, b] of scenes) {
    // snap to a nearby band edge so the scene and its section line up
    const near = v => bands.flat().reduce((best, c) => Math.abs(c - v) < Math.abs(best - v) ? c : best, v);
    const y0 = Math.abs(near(a) - a) <= 20 ? near(a) : a, y1 = Math.abs(near(b) - b) <= 20 ? near(b) : b;
    const kept = bands.filter(([s0, s1]) => s1 <= y0 || s0 >= y1);
    const cutBefore = bands.filter(([s0, s1]) => s0 < y0 && s1 > y0).map(([s0]) => [s0, y0]);
    const cutAfter = bands.filter(([s0, s1]) => s0 < y1 && s1 > y1).map(([, s1]) => [y1, s1]);
    bands.splice(0, bands.length, ...[...kept, ...cutBefore, [y0, y1], ...cutAfter].filter(([s0, s1]) => s1 - s0 > 0).sort((p, q) => p[0] - q[0]));
  }
  const sceneBoxes = scenes.map(([a, b]) => { const band = bands.find(([s0, s1]) => s0 <= a + 20 && s1 >= b - 20) || [a, b]; return [0, band[0], W, band[1] - band[0]]; });
  const bandInfo = bands.map(([a, b]) => ({ y0: a, y1: b, bg: sceneBoxes.some(sb => sb[1] === a && sb[1] + sb[3] === b)
    ? { kind: 'mixed', color: bandBackground(img, a, b).color, scene: true, gradient: colourStops(img, [0, a, W, b - a]) } : bandBackground(img, a, b) }));
  tick('text+bands', t0);

  t0 = performance.now();
  const textBoxes = lines.map(l => grow(l.box, 2, W, H));
  const { regions, labels } = flatRegions(img);
  const bandAt = box => bandInfo.find(b => box[1] + box[3] / 2 >= b.y0 && box[1] + box[3] / 2 < b.y1) || bandInfo.at(-1);
  const candidates = [], thin = [], gradientBoxes = [], photoFrames = [];
  for (const r of regions) {
    const [x, y, w, h] = r.box;
    const band = bandAt(r.box);
    if ((h <= 3 && w >= 24) || (w <= 3 && h >= 24)) { if (r.area >= 0.8 * w * h) thin.push({ box: r.box, color: r.color }); continue; }
    const bar = h >= 3 && w >= 40 && w >= 8 * h && r.area >= 0.9 * w * h;
    if (!bar && (w < 24 || h < 16)) continue;
    if (w >= W * 0.97 && h >= (band.y1 - band.y0) * 0.6) continue;
    // a thin rectangular ring is a bordered box
    if (r.area <= 2.2 * (w + h) * 3) {
      const onEdge = (pts, test) => pts.filter(test).length >= pts.length - 1;
      const xs = [0.2, 0.35, 0.5, 0.65, 0.8].map(f => Math.round(x + w * f)), ys = [0.25, 0.5, 0.75].map(f => Math.round(y + h * f));
      const hit = (px, py0, dy) => [0, 1, 2, 3].some(k => { const py = py0 + dy * k; return py >= 0 && py < H && labels[py * W + px] === r.id; });
      const hitX = (py, px0, dx) => [0, 1, 2, 3].some(k => { const px = px0 + dx * k; return px >= 0 && px < W && labels[py * W + px] === r.id; });
      if (onEdge(xs, px => hit(px, y, 1)) && onEdge(xs, px => hit(px, y + h - 1, -1)) && onEdge(ys, py => hitX(py, x, 1)) && onEdge(ys, py => hitX(py, x + w - 1, -1))) {
        const t = Math.max(1, Math.round(r.area / (2 * (w + h))));
        candidates.push({ box: r.box, fill: interiorFill(img, grow(r.box, -t - 1, W, H), textBoxes), border: `${t}px solid ${hex(r.color)}`, borderWidth: t, source: 'ring' });
      }
      continue;
    }
    if ((!bar && r.area < 400) || r.area < 0.6 * w * h) continue;
    if (w * h >= 0.5 * W * (band.y1 - band.y0) && dist(r.color, band.bg.color) <= 12) continue;
    if (textBoxes.some(t => inside(r.box, t, 2))) continue;
    // an evenly coloured region with photo grain is a photo, not a filled box
    if (w >= 100 && h >= 80 && grain(img, grow(r.box, -4, W, H), textBoxes) >= 0.06 && !lines.some(l => intersects(l.box, grow(r.box, -4, W, H)))) { photoFrames.push({ box: r.box, photo: true }); continue; }
    candidates.push({ box: r.box, fill: r.color, source: 'fill' });
  }
  const merged = mergeRules(thin.map(t => ({ ...t, color: t.color })));
  for (const m of merged) {
    const core = m.parts.reduce((best, p) => !best || dist(p.color, bandAt(m.box).bg.color) > dist(best.color, bandAt(m.box).bg.color) ? p : best, null);
    m.color = core.color;
  }
  for (const l of lines) if (l.fillBox) candidates.push({ box: l.fillBox, fill: l.fillColor, source: 'fill' });
  const { hs, vs } = edgeSegments(img);
  // the page border closes shapes that bleed off the page (a split photo running to the left or right edge)
  vs.push({ x: 0, y0: 0, y1: H - 1 }, { x: W, y0: 0, y1: H - 1 });
  for (const r of edgeRects(img, hs, vs, textBoxes)) {
    const [, , w, h] = r.box;
    if (w < 24 || h < 16 || (w >= W * 0.97 && h >= (bandAt(r.box).y1 - bandAt(r.box).y0) * 0.6)) continue;
    if (textBoxes.some(t => inside(r.box, t, 2))) continue;
    if (r.gradient) { gradientBoxes.push(r); continue; }
    if (r.photo) { if (!lines.some(l => intersects(l.box, grow(r.box, -4, W, H)))) photoFrames.push(r); continue; }
    const border = lineBorder(img, r.box, r.fill);
    candidates.push({ box: r.box, fill: r.fill, border, borderWidth: border ? 1 : 0, source: border ? 'ring' : 'lines' });
  }
  // thin standalone lines from paired edges (top and bottom edge of a 1-4px line)
  for (const a of hs) for (const b of hs) {
    if (b.y - a.y < 1 || b.y - a.y > 4 || Math.abs(a.x0 - b.x0) > 3 || Math.abs(a.x1 - b.x1) > 3) continue;
    const box = [Math.min(a.x0, b.x0), a.y, Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0) + 1, b.y - a.y];
    const color = modeColor([0.2, 0.4, 0.6, 0.8].map(f => img.at(Math.round(box[0] + box[2] * f), box[1] + (box[3] >> 1))), 12).color;
    merged.push({ box, horizontal: true, color, parts: [] });
  }
  // keep one box per place, preferring ones whose border is known
  const iou = (a, b) => { const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])), y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    return x * y / (a[2] * a[3] + b[2] * b[3] - x * y); };
  const rank = c => c.source === 'ring' ? 0 : c.source === 'lines' ? 1 : 2;
  const boxes = [];
  for (const c of candidates.sort((a, b) => rank(a) - rank(b) || b.box[2] * b.box[3] - a.box[2] * a.box[3])) {
    const same = boxes.find(b => iou(b.box, c.box) > 0.8 || (inside(c.box, b.box) && c.box[2] >= b.box[2] - 8 && c.box[3] >= b.box[3] - 8));
    if (same) { if (c.source === 'fill' && same.source !== 'fill') same.fill = c.fill; continue; }
    boxes.push(c);
  }
  const nearBox = r => boxes.some(b => { const g = grow(b.box, 4, W, H); return inside(r.box, g) && !inside(r.box, grow(b.box, -4, W, H)); });
  const rules = [];
  for (const m of merged.filter(m => !nearBox(m) && standaloneRule(img, m)))
    if (!rules.some(r => intersects(grow(r.box, 2, W, H), m.box))) rules.push({ box: m.box, color: hex(m.color) });
  // local background: band colour, then box fills (largest first)
  const localBg = new Uint8Array(W * H * 3);
  for (const b of bandInfo) for (let y = b.y0; y < b.y1; y++) for (let x = 0; x < W; x++) localBg.set(b.bg.color.map(Math.round), (y * W + x) * 3);
  const ignore = new Uint8Array(W * H);
  const paint = (box, fn) => { for (let y = box[1]; y < box[1] + box[3]; y++) for (let x = box[0]; x < box[0] + box[2]; x++) fn(y * W + x); };
  for (const b of [...boxes].sort((a, c) => c.box[2] * c.box[3] - a.box[2] * a.box[3])) {
    if (b.source === 'fill') Object.assign(b, boxStyle(img, b.box, b.fill));
    else b.radius = boxStyle(img, grow(b.box, -(b.borderWidth || 1), W, H), b.fill).radius;
    const fill = b.fill.map(Math.round);
    paint(b.box, p => localBg.set(fill, p * 3));
    const inner = b.source === 'fill' ? b.box : grow(b.box, -((b.borderWidth || 1) + 1), W, H);
    const ring = b.source === 'fill' ? grow(b.box, (b.borderWidth || 0) + 1, W, H) : grow(b.box, 1, W, H);
    paint(ring, p => { const x = p % W, y = (p - x) / W; if (!(x >= inner[0] && x < inner[0] + inner[2] && y >= inner[1] && y < inner[1] + inner[3])) ignore[p] = 1; });
    const r = b.radius + 2;
    for (const [cx, cy] of [[b.box[0], b.box[1]], [b.box[0] + b.box[2] - r, b.box[1]], [b.box[0], b.box[1] + b.box[3] - r], [b.box[0] + b.box[2] - r, b.box[1] + b.box[3] - r]])
      paint(grow([cx, cy, r, r], 0, W, H), p => { ignore[p] = 1; });
  }
  for (const t of lines) paint(grow(t.box, 3, W, H), p => { ignore[p] = 1; });
  for (const t of splitIcons) paint(grow(t.box, 3, W, H), p => { ignore[p] = 1; });
  for (const r of rules) paint(grow(r.box, 1, W, H), p => { ignore[p] = 1; });
  for (const g of gradientBoxes) {
    const inner = grow(g.box, -3, W, H);
    paint(grow(g.box, 2, W, H), p => { const x = p % W, y = (p - x) / W; if (!(x >= inner[0] && x < inner[0] + inner[2] && y >= inner[1] && y < inner[1] + inner[3])) ignore[p] = 1; });
  }
  for (const d of rowDividers) paint([0, d.y, W, d.height], p => { ignore[p] = 1; });
  for (const b of bandInfo.slice(1)) paint(grow([0, b.y0, W, 1], 7, W, H), p => { ignore[p] = 1; });
  tick('boxes', t0);

  t0 = performance.now();
  const blobs = busyComponents(img, localBg, ignore);
  const images = [], icons = [], unread = [];
  const bimodal = box => {
    const [x, y, w, h] = box, bg = [localBg[(y * W + x) * 3], localBg[(y * W + x) * 3 + 1], localBg[(y * W + x) * 3 + 2]];
    const pts = [];
    const step = Math.max(1, Math.floor(Math.sqrt(w * h / 4000)));
    for (let yy = y; yy < y + h; yy += step) for (let xx = x; xx < x + w; xx += step) pts.push(img.at(xx, yy));
    const far = pts.filter(c => dist(c, bg) > 25);
    if (!far.length) return { ok: true, ink: bg };
    const ink = modeColor(far, 24).color;
    return { ok: (pts.length - far.length + far.filter(c => dist(c, ink) <= 48).length) / pts.length >= 0.86, ink };
  };
  icons.push(...splitIcons);
  // a photo often fades on one side, which stops edge detection early: grow it while the next strip is still grain
  for (const f of photoFrames) {
    let [x0, y0, w, h] = f.box, x1 = x0 + w, y1 = y0 + h;
    const textAt = b => lines.some(l => intersects(l.box, b));
    for (let more = true; more;) {
      more = false;
      if (x1 < W && !textAt([x1, y0, Math.min(8, W - x1), y1 - y0]) && grain(img, [x1, y0, Math.min(8, W - x1), y1 - y0]) >= 0.04) { x1 = Math.min(W, x1 + 8); more = true; }
      if (x0 > 0 && !textAt([Math.max(0, x0 - 8), y0, Math.min(8, x0), y1 - y0]) && grain(img, [Math.max(0, x0 - 8), y0, Math.min(8, x0), y1 - y0]) >= 0.04) { x0 = Math.max(0, x0 - 8); more = true; }
      const w2 = x1 - x0;
      if (y0 > 0 && !textAt([x0, Math.max(0, y0 - 8), w2, Math.min(8, y0)]) && grain(img, [x0, Math.max(0, y0 - 8), w2, Math.min(8, y0)]) >= 0.04) { y0 = Math.max(0, y0 - 8); more = true; }
      if (y1 < H && !textAt([x0, y1, w2, Math.min(8, H - y1)]) && grain(img, [x0, y1, w2, Math.min(8, H - y1)]) >= 0.04) { y1 = Math.min(H, y1 + 8); more = true; }
    }
    images.push({ box: [x0, y0, x1 - x0, y1 - y0], smooth: 99, frame: true });
  }
  for (const sb of sceneBoxes) images.push({ box: sb, smooth: 99, scene: true });
  for (const g of gradientBoxes) {
    const outside = bandAt(g.box).bg.color;
    let k = 0;
    while (k < Math.min(g.box[2], g.box[3]) / 2 && dist(img.at(g.box[0] + k, g.box[1] + k), outside) <= 12) k++;
    images.push({ box: g.box, smooth: 0, stops: g.gradient, radius: Math.round(k * 3.41) });
  }
  for (const b of blobs) {
    const [x, y, w, h] = b.box;
    const shape = bimodal(b.box);
    if (Math.max(w, h) <= 64 && Math.min(w, h) >= 7 && Math.max(w, h) / Math.min(w, h) <= 2.2) icons.push({ box: b.box });
    else if (shape.ok && h >= 6 && h <= 140) unread.push({ box: b.box, color: hex(shape.ink) });
    else if (w >= 40 && h >= 40 && b.ink >= 400) images.push({ box: b.box, smooth: smoothness(img, b.box) });
    else if (h >= 6 && w >= 6) unread.push({ box: b.box, color: hex(shape.ink) });
  }
  // one crop per picture: drop image regions that sit inside a larger one
  images.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
  const share = (a, b) => { const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])), y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])); return x * y / (a[2] * a[3]); };
  for (let k = images.length - 1; k >= 0; k--) if (images.some((o, j) => j < k && o.box[2] * o.box[3] <= 0.4 * W * H && share(images[k].box, o.box) >= 0.7)) images.splice(k, 1);
  // a photo frame or a full-width scene is the picture; fragments of it are dropped
  for (let k = images.length - 1; k >= 0; k--) {
    const im = images[k];
    if (im.frame || im.scene) continue;
    if (images.some(o => (o.frame && share(im.box, o.box) >= 0.4) || (o.scene && share(im.box, o.box) >= 0.5))) images.splice(k, 1);
  }
  images.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  // drop boxes, icons and OCR noise inside images
  const inImage = box => images.some(i => i.smooth >= 1.6 && inside(box, i.box, 2));
  const keptBoxes = boxes.filter(b => !inImage(b.box) || lines.some(l => inside(l.box, b.box, 2)));
  const keptIcons = icons.filter(i => !inImage(i.box));
  for (let k = lines.length - 1; k >= 0; k--) if (images.some(i => i.smooth >= 1.6 && !i.scene && inside(lines[k].box, i.box, 2)) && lines[k].bgCoverage < 0.6 && lines[k].confidence < 0.85) lines.splice(k, 1);
  if (process.env.I2C_DEBUG_MARKS) console.error('marks', JSON.stringify(unread.map(u => u.box)), 'icons', JSON.stringify(keptIcons.map(k => k.box)));
  // on a full-width photo, text is expected on top: letter-like marks there wait for the zoomed re-read
  // (whatever still can't be read is dropped by the last pass)
  const sceneText = box => images.some(i => i.scene && inside(box, i.box, 2)) && box[3] >= 8 && box[3] <= 120 && box[2] >= 1.5 * box[3];
  for (let k = unread.length - 1; k >= 0; k--) if (inImage(unread[k].box) && !sceneText(unread[k].box)) unread.splice(k, 1);

  // glue OCR fragments, unread blobs and letter-sized "icons" that share a baseline into one text item
  const boxOf = b => keptBoxes.find(x => inside(b, x.box, 1))?.id || null;
  const pieces = [...lines.map(l => ({ kind: 'line', ref: l, box: l.box })), ...unread.map(u => ({ kind: 'blob', ref: u, box: u.box })),
    ...keptIcons.map(k => ({ kind: 'icon', ref: k, box: k.box }))].sort((a, b) => a.box[0] - b.box[0]);
  const runs = [];
  for (const p of pieces) {
    const [x, y, w, h] = p.box;
    const fits = r => {
      const last = r.at(-1), [lx, ly, lw, lh] = last.box, hh = Math.max(h, lh);
      const gap = x - (lx + lw);
      // letter-spaced capitals have wide word gaps: two all-caps pieces of one height may sit further apart
      const caps = t => t && /[A-Z]/.test(t) && !/[a-z]/.test(t);
      // (a letter-height blob next to a caps line is a letter OCR missed)
      const capsLike = q => q.kind === 'line' ? caps(q.ref.text) : q.kind === 'blob';
      const spaced = (p.kind === 'line' || last.kind === 'line') && capsLike(p) && capsLike(last) && Math.abs(h - lh) <= 1;
      return Math.abs(y + h / 2 - (ly + lh / 2)) <= 0.35 * hh && h / lh > 0.55 && h / lh < 1.8 && gap >= (p.kind === 'line' && last.kind === 'line' ? -0.6 * Math.min(w, lw) : -2) && gap <= (spaced ? 2.4 : 0.6) * hh && boxOf(p.box) === boxOf(last.box);
    };
    // the nearest fitting run, not the first one found
    const run = runs.filter(fits).sort((a, b) => (x - (a.at(-1).box[0] + a.at(-1).box[2])) - (x - (b.at(-1).box[0] + b.at(-1).box[2])))[0];
    if (run) run.push(p); else runs.push([p]);
  }
  if (process.env.I2C_DEBUG_GLUE) for (const r of runs) if (r.length > 1 || r[0].kind === 'line') console.error('run', JSON.stringify(r.map(p => [p.kind, p.box, p.ref.text || ''])));
  const drop = new Set();
  for (const run of runs) {
    if (run.length < 2) continue;
    const texts = run.filter(p => p.kind === 'line');
    if (!texts.length && run.length < 3) continue;
    run.forEach(p => drop.add(p.ref));
    const box = union(run.map(p => p.box));
    if (texts.length) {
      const text = run.map(p => p.kind === 'line' ? p.ref.text : '…').join(' ').replace(/(… )+…/g, '…');
      const merged = measureText(img, { text, bounds: box, confidence: Math.min(...texts.map(t => t.ref.confidence)) });
      // wide gaps between pieces usually hide letters OCR missed: re-read the merged line zoomed
      // overlapping pieces are two OCR passes disagreeing about the same words: re-read too
      const wideGap = run.some((p, i) => i && (p.box[0] - (run[i - 1].box[0] + run[i - 1].box[2]) > 0.8 * Math.max(p.box[3], run[i - 1].box[3]) || p.box[0] < run[i - 1].box[0] + run[i - 1].box[2] - 2));
      if (merged) { merged.partial = run.some(p => p.kind !== 'line') || wideGap; lines.push(merged); drop.delete(merged); }
    } else unread.push({ box, color: hex(modeColor(run.map(p => [1, 3, 5].map(k => parseInt((p.ref.color || '#000000').slice(k, k + 2), 16))), 16).color), letters: true });
  }
  for (const list of [lines, unread, keptIcons]) for (let k = list.length - 1; k >= 0; k--) if (drop.has(list[k])) list.splice(k, 1);
  for (let k = lines.length - 1; k >= 0; k--) {
    const text = lines[k].text.trim();
    if ((text.match(/[A-Za-z0-9]/g) || []).length <= 2 && !/^\d+$/.test(text)) { unread.push({ box: lines[k].box, color: hex(lines[k].color) }); lines.splice(k, 1); }
  }
  tick('media', t0);

  // ---------- second look: re-read partly read lines and text-like marks one line at a time, zoomed 3x ----------
  t0 = performance.now();
  for (let changed = true; changed;) {
    changed = false;
    unread.sort((a, b) => a.box[0] - b.box[0]);
    for (let i = 0; i < unread.length && !changed; i++) for (let j = 0; j < unread.length && !changed; j++) {
      const a = unread[i].box, b = unread[j].box, h = Math.max(a[3], b[3]);
      if (i !== j && b[0] >= a[0] + a[2] - 2 && b[0] - (a[0] + a[2]) <= 0.7 * h && Math.abs(a[1] + a[3] / 2 - b[1] - b[3] / 2) <= 0.35 * h && a[3] / b[3] > 0.6 && a[3] / b[3] < 1.6) {
        unread[i] = { ...unread[i], box: union([a, b]) }; unread.splice(j, 1); changed = true;
      }
    }
  }
  const targets = [...lines.filter(l => l.partial).map(l => ({ kind: 'line', ref: l, box: l.box })),
    ...unread.filter(u => u.box[3] >= 7 && u.box[3] <= 80 && u.box[2] >= 2 * u.box[3]).map(u => ({ kind: 'mark', ref: u, box: u.box }))];
  // a mark often misses its first or last letters: read it with about one letter height of room on each side
  for (const t of targets) if (t.kind === 'mark') {
    const m = Math.round(t.box[3] * 1.1), x0 = Math.max(0, t.box[0] - m), x1 = Math.min(W, t.box[0] + t.box[2] + m);
    t.readBox = [x0, t.box[1], x1 - x0, t.box[3]];
  }
  const jobs = targets.flatMap((t, i) => t.readBox ? [{ i, box: t.box }, { i, box: t.readBox, wide: true }] : [{ i, box: t.box }]);
  const crops = await Promise.all(jobs.map(async job => {
    const t = targets[job.i];
    const g = grow(job.box, Math.max(3, Math.round(t.box[3] * 0.3)), W, H);
    // dark text on light, contrast stretched by hand (sharp would apply negate/normalise after the padding)
    const px = await sharp(source).extract({ left: g[0], top: g[1], width: g[2], height: g[3] }).greyscale().raw().toBuffer();
    const mean = px.reduce((a, v) => a + v, 0) / px.length;
    if (mean < 128) for (let k = 0; k < px.length; k++) px[k] = 255 - px[k];
    let lo = 255, hi = 0;
    for (const v of px) { if (v < lo) lo = v; if (v > hi) hi = v; }
    for (let k = 0; k < px.length; k++) px[k] = hi > lo ? Math.round(255 * (px[k] - lo) / (hi - lo)) : px[k];
    const big = await sharp(px, { raw: { width: g[2], height: g[3], channels: 1 } }).resize({ width: g[2] * 3, kernel: 'lanczos3' }).png().toBuffer();
    return sharp(big).extend({ top: 12, bottom: 12, left: 12, right: 12, background: '#ffffff' }).png().toBuffer();
  }));
  const jobReads = await readLines(crops, { language });
  // second try for empty or weak reads: pure black and white
  const retry = jobReads.map((r, i) => r.confidence < 0.6 ? i : -1).filter(i => i >= 0);
  if (retry.length) {
    const bw = await Promise.all(retry.map(i => sharp(crops[i]).threshold(150).png().toBuffer()));
    const again = await readLines(bw, { language });
    retry.forEach((i, k) => { if (again[k].confidence > jobReads[i].confidence) jobReads[i] = again[k]; });
  }
  // per target, the more confident of the tight and the wide read
  const reads = targets.map(() => ({ text: '', confidence: 0 }));
  jobs.forEach((job, k) => { if (jobReads[k].confidence > reads[job.i].confidence) { reads[job.i] = jobReads[k]; targets[job.i].useWide = Boolean(job.wide); } });
  if (process.env.I2C_DEBUG_REREAD) targets.forEach((t, i) => console.error('reread', t.kind, t.box.join(','), JSON.stringify(reads[i])));
  const despace = text => { const tokens = text.split(' '); return tokens.length >= 3 && tokens.filter(t => t.length === 1).length / tokens.length >= 0.7
    ? text.replace(/ {2,}/g, '\u0000').replace(/ /g, '').replace(/\u0000/g, ' ') : text; };
  targets.forEach((t, i) => {
    const r = reads[i], text = despace(r.text);
    if (r.confidence < (t.kind === 'mark' ? 0.8 : 0.6) || (text.match(/[A-Za-z0-9]/g) || []).length < 2) return;
    const nChars = [...text].length;
    const rb = t.useWide ? t.readBox : t.box;
    if (t.box[2] > 1.5 * t.box[3] * nChars || rb[2] < 0.22 * t.box[3] * nChars) return;
    if (t.kind === 'line') { if (!text.includes('…')) { t.ref.text = text; t.ref.partial = false; t.ref.confidence = r.confidence; t.ref.reread = true; } return; }
    const line = measureText(img, { text, bounds: t.useWide ? t.readBox : t.box, confidence: r.confidence });
    if (!line) return;
    line.reread = true;
    lines.push(line);
    unread.splice(unread.indexOf(t.ref), 1);
  });
  // drop duplicates and impossible measurements: a line inside another line, or far too narrow for its text
  const cover = (a, b) => { const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])), y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    return x * y / Math.max(1, a[2] * a[3]); };
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k], chars = [...l.text.replace(/\s/g, '')].length;
    const narrow = l.box[2] < 0.22 * l.box[3] * chars || (chars <= 3 && l.box[2] > 1.6 * l.box[3] * chars);
    const inside = lines.some((o, j) => o !== l && (o.box[2] * o.box[3] > l.box[2] * l.box[3] || (j < k && o.box[2] * o.box[3] === l.box[2] * l.box[3])) && cover(l.box, o.box) >= 0.6);
    // a short fragment inside a much larger unread block is a piece of that block, not its own text
    const fragment = (l.text.match(/[A-Za-z0-9]/g) || []).length <= 4 && unread.some(u => cover(l.box, u.box) >= 0.8 && u.box[2] * u.box[3] >= 4 * l.box[2] * l.box[3]);
    if (narrow || inside || fragment) lines.splice(k, 1);
  }
  tick('reread', t0);

  // thin vertical marks running alongside a box on both sides are that box's border (rounded inputs)
  for (const b of keptBoxes) {
    const [bx0, by0, bw, bh] = b.box;
    const side = right => unread.find(u => u.box[2] <= 3 && u.box[3] >= 0.6 * bh && Math.min(u.box[1] + u.box[3], by0 + bh) - Math.max(u.box[1], by0) >= 0.6 * u.box[3] &&
      (right ? u.box[0] >= bx0 + bw - 1 && u.box[0] <= bx0 + bw + 8 : u.box[0] + u.box[2] <= bx0 + 1 && u.box[0] >= bx0 - 8));
    const l = side(false), r = side(true);
    if (!l || !r) continue;
    const inset = Math.max(bx0 - l.box[0], 0);
    b.box = [l.box[0], Math.max(0, by0 - inset), r.box[0] + r.box[2] - l.box[0], bh + 2 * inset];
    b.border = `1px solid ${l.color}`; b.borderWidth = 1; b.radius = Math.max(b.radius || 0, Math.round(inset * 2));
    unread.splice(unread.indexOf(l), 1); unread.splice(unread.indexOf(r), 1);
  }

  // ---------- text blocks ----------
  t0 = performance.now();
  lines.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  const blocks = [];
  for (const line of lines) {
    const [x, y, w, h] = line.box;
    const block = blocks.find(b => {
      const last = b.lines.at(-1);
      const [lx, ly, lw, lh] = last.box;
      const gap = y - (ly + lh);
      const sameEdge = Math.abs(x - lx) <= Math.max(6, lh * 0.5) || Math.abs(x + w / 2 - (lx + lw / 2)) <= 6 || Math.abs(x + w - (lx + lw)) <= 6;
      return sameEdge && gap >= -2 && gap <= 1.3 * Math.max(h, lh) && h / lh > 0.7 && h / lh < 1.45 && dist(line.color, last.color) <= 40 &&
        keptBoxes.every(bx => inside(line.box, bx.box, 1) === inside(last.box, bx.box, 1));
    });
    if (block) block.lines.push(line); else blocks.push({ lines: [line] });
  }
  tick('blocks', t0);

  blocks.forEach((b, i) => b.lines.forEach(l => { l.blockIndex = i; }));
  t0 = performance.now();
  const library = await fontLibrary();
  const fontSummary = await fitFonts(lines, library);
  tick('fonts', t0);

  // ---------- sections: bands split at large empty strips ----------
  const occupied = [...blocks.map(b => union(b.lines.map(l => l.box))), ...keptBoxes.map(b => b.box), ...images.map(i => i.box), ...keptIcons.map(i => i.box)];
  const sections = [];
  for (const band of bandInfo) {
    const rows = new Uint8Array(band.y1 - band.y0);
    for (const o of occupied) for (let y = Math.max(o[1], band.y0); y < Math.min(o[1] + o[3], band.y1); y++) rows[y - band.y0] = 1;
    const cuts = [band.y0];
    let gapStart = null, seenContent = band.bg.scene ? null : false;
    for (let y = band.y0; y < band.y1; y++) {
      if (rows[y - band.y0]) { if (!band.bg.scene && gapStart != null && seenContent && y - gapStart >= 48) cuts.push(Math.round((gapStart + y) / 2)); gapStart = null; seenContent = true; }
      else if (gapStart == null) gapStart = y;
    }
    cuts.push(band.y1);
    for (let i = 0; i < cuts.length - 1; i++) sections.push({ y0: cuts[i], y1: cuts[i + 1], bg: band.bg, continued: i > 0 });
  }
  sections.forEach((s, i) => { s.id = `S${i + 1}`; });
  const inPhotoBox = box => images.some(i => i.kind !== 'gradient' && !i.scene && share(box, i.box) >= 0.5);
  const sectionOf = box => sections.find(s => box[1] + box[3] / 2 >= s.y0 && box[1] + box[3] / 2 < s.y1) || sections.at(-1);

  // ---------- assets ----------
  t0 = performance.now();
  const catalog = assetsDir ? await catalogAssets(assetsDir, dir) : [];
  const supplied = await Promise.all(catalog.map(async a => ({ ...a, thumb: await thumb(path.resolve(dir, a.path)).catch(() => null) })));
  const allText = lines.map(l => l.box);
  for (let k = rules.length - 1; k >= 0; k--) if (lines.some(l => intersects(grow(l.box, 3, W, H), rules[k].box)) || inImage(rules[k].box) || sceneBoxes.some(sb => inside(rules[k].box, sb, 1))) rules.splice(k, 1);
  for (const [i, im] of images.entries()) {
    im.id = `I${i + 1}`;
    im.behindText = lines.some(l => intersects(l.box, im.box) && l.bgCoverage < 0.6);
    // smooth AND grain-free is a CSS gradient; a soft photo is smooth but still has grain
    if (im.smooth < 1.6 && grain(img, grow(im.box, -4, W, H), allText) < 0.04) {
      const at = (x, y) => hex(img.at(clamp(Math.round(x), 0, W - 1), clamp(Math.round(y), 0, H - 1)));
      const [x, y, w, h] = im.box;
      im.kind = 'gradient';
      im.gradient = { top: at(x + w / 2, y + 1), bottom: at(x + w / 2, y + h - 2), left: at(x + 1, y + h / 2), right: at(x + w - 2, y + h / 2) };
      im.stand = im.stops || colourStops(img, im.box);
      continue;
    }
    im.kind = 'image';
    if (supplied.length) {
      const t = await thumb(source, im.box);
      const scored = supplied.filter(s => s.thumb).map(s => ({ s, err: s.thumb.reduce((sum, v, k) => sum + Math.abs(v - t[k]), 0) / 256 })).sort((a, b) => a.err - b.err);
      if (scored[0] && scored[0].err < 28) {
        const ext = path.extname(scored[0].s.path);
        await fs.copyFile(path.resolve(dir, scored[0].s.path), path.join(dir, 'assets', `${im.id}${ext}`));
        im.file = `assets/${im.id}${ext}`; im.route = 'supplied original'; im.match = scored[0].s.name;
        continue;
      }
    }
    // a page-sized busy area carrying lots of text is a textured background, not a photo
    if (!im.scene && im.behindText && im.box[2] * im.box[3] > 0.4 * W * H && lines.filter(l => inside(l.box, im.box)).length >= 8) { im.kind = 'texture'; im.route = 'textured page background (left to the section colour)'; continue; }
    if (im.scene) im.behindText = lines.some(l => intersects(l.box, im.box));
    if (im.behindText) { im.route = im.scene ? 'full-width background photo with text on top: needs the original or a generated image (do not crop it); a colour stand-in is given'
      : 'needs a generated or supplied image (text sits on top of it; do not crop it)'; im.stand = colourStops(img, im.box); continue; }
    // Candidate crop with a margin. Reject margin collisions rather than painting live UI out.
    const band = bandInfo.find(b => im.box[1] + im.box[3] / 2 >= b.y0 && im.box[1] + im.box[3] / 2 < b.y1) || bandInfo[0];
    let crop = im.frame ? [...im.box] : grow(im.box, 12, W, H);
    const top = Math.max(crop[1], band.y0 > 0 ? band.y0 + 9 : 0), bottom = Math.min(crop[1] + crop[3], band.y1 < H ? band.y1 - 9 : H);
    crop = [crop[0], top, crop[2], Math.max(1, bottom - top)];
    const around = box => { const g = grow(box, 4, W, H), pts = [];
      for (let x = g[0]; x < g[0] + g[2]; x += 2) { pts.push(img.at(x, g[1])); pts.push(img.at(x, g[1] + g[3] - 1)); }
      for (let y = g[1]; y < g[1] + g[3]; y += 2) { pts.push(img.at(g[0], y)); pts.push(img.at(g[0] + g[2] - 1, y)); }
      return hex(modeColor(pts, 6).color); };
    const covers = [...lines.map(l => l.box), ...keptBoxes.map(b => b.box), ...keptIcons.map(k => k.box)]
      .filter(t => intersects(t, crop) && !inside(im.box, t)).map(t => ({ box: grow(t, 3, W, H), color: around(t) }));
    if (covers.length) { im.route = 'crop margin intersects page content: visually review a smaller independent crop or provide an original'; continue; }
    const rgb = await sharp(source).extract({ left: crop[0], top: crop[1], width: crop[2], height: crop[3] })
      .removeAlpha().raw().toBuffer();
    // feather the edges that sit on plain background so the crop blends into the page colour
    const bgc = band.bg.color, F = 14, cw = crop[2], chh = crop[3];
    const plain = (xs, ys) => { let n = 0, ok = 0; for (const x of xs) for (const y of ys) { const o = (y * cw + x) * 3; n++; if (dist([rgb[o], rgb[o + 1], rgb[o + 2]], bgc) <= 22) ok++; } return ok / n > 0.85; };
    const rangeX = [...Array(cw).keys()].filter(x => x % 4 === 0), rangeY = [...Array(chh).keys()].filter(y => y % 4 === 0);
    const soft = im.frame ? { top: false, bottom: false, left: false, right: false }
      : { top: plain(rangeX, [0, 1]), bottom: plain(rangeX, [chh - 1, chh - 2]), left: plain([0, 1], rangeY), right: plain([cw - 1, cw - 2], rangeY) };
    const rgba = Buffer.alloc(cw * chh * 4);
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) {
      let a = 1;
      if (soft.left) a = Math.min(a, x / F); if (soft.right) a = Math.min(a, (cw - 1 - x) / F);
      if (soft.top) a = Math.min(a, y / F); if (soft.bottom) a = Math.min(a, (chh - 1 - y) / F);
      const o = (y * cw + x) * 3, q = (y * cw + x) * 4;
      rgba[q] = rgb[o]; rgba[q + 1] = rgb[o + 1]; rgba[q + 2] = rgb[o + 2]; rgba[q + 3] = Math.round(255 * Math.max(0, Math.min(1, a)));
    }
    await sharp(rgba, { raw: { width: cw, height: chh, channels: 4 } }).png().toFile(path.join(dir, 'assets', `${im.id}.png`));
    im.box = crop; im.file = `assets/${im.id}.png`;
    im.route = `candidate crop${Object.values(soft).some(Boolean) ? ', edges faded to transparent' : ''}; visually confirm its boundary and independence`;
  }
  const lucide = keptIcons.length ? await lucideMasks() : [];
  for (const [i, ic] of keptIcons.entries()) {
    ic.id = `K${i + 1}`;
    const [x, y, w, h] = ic.box;
    const bg = [localBg[(y * W + x) * 3], localBg[(y * W + x) * 3 + 1], localBg[(y * W + x) * 3 + 2]];
    const mask = new Uint8Array(w * h);
    const inks = [];
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const c = img.at(x + xx, y + yy);
      if (dist(c, bg) > 40) { mask[yy * w + xx] = 1; inks.push(c); }
    }
    ic.color = hex(modeColor(inks, 16).color);
    ic.lucide = matchIcon(normalizeMask(mask, w, h), lucide).map(m => m.name);
    const crop = grow(ic.box, 2, W, H);
    await sharp(source).extract({ left: crop[0], top: crop[1], width: crop[2], height: crop[3] }).png().toFile(path.join(dir, 'icons', `${ic.id}.png`));
    ic.file = `icons/${ic.id}.png`; ic.fileBox = crop;
  }
  tick('assets', t0);

  // filled shapes found under text (buttons, badges) that no other step reported
  const boxIou = (a, b) => { const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])), y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])); return x * y / (a[2] * a[3] + b[2] * b[3] - x * y || 1); };
  for (const l of lines) {
    if (!l.fillBox || keptBoxes.some(b => boxIou(b.box, l.fillBox) > 0.6) || inPhotoBox(l.fillBox)) continue;
    const [fx, fy, fw, fh] = l.fillBox;
    let d = 0; while (d < fh / 2 && dist(img.at(fx + d, fy + d), l.fillColor) > 14) d++;
    keptBoxes.push({ box: l.fillBox, fill: l.fillColor, border: null, borderWidth: 0, source: 'fill', radius: Math.min(Math.round(fh / 2), Math.round(d * 3.4)) });
  }
  // ---------- ids and relations ----------
  keptBoxes.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]).forEach((b, i) => { b.id = `B${i + 1}`; });
  unread.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]).forEach((u, i) => { u.id = `U${i + 1}`; });
  rules.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]).forEach((r, i) => { r.id = `L${i + 1}`; });
  for (const d of rowDividers) { if (sceneBoxes.some(sb => d.y >= sb[1] && d.y < sb[1] + sb[3])) continue; const r = { id: `L${rules.length + 1}`, box: [0, d.y, W, d.height], color: d.color }; rules.push(r); }
  const sectionContent = new Map();
  const textBlocks = blocks.map((b, i) => {
    const box = union(b.lines.map(l => l.box));
    const lefts = b.lines.map(l => l.box[0]), centers = b.lines.map(l => l.box[0] + l.box[2] / 2), rights = b.lines.map(l => l.box[0] + l.box[2]);
    const spread = v => Math.max(...v) - Math.min(...v);
    const container = keptBoxes.filter(bx => inside(box, bx.box, 1)).sort((a, c) => a.box[2] * a.box[3] - c.box[2] * c.box[3])[0];
    let align = 'left';
    if (b.lines.length > 1) align = spread(lefts) <= 3 ? 'left' : spread(centers) <= 4 ? 'center' : spread(rights) <= 3 ? 'right' : 'left';
    else {
      const ref = container ? container.box : [0, 0, W, H];
      if (Math.abs(centers[0] - (ref[0] + ref[2] / 2)) <= 4 && (container || Math.abs(lefts[0] - W * 0.5) > 40)) align = 'center';
    }
    const pitch = b.lines.length > 1 ? median(b.lines.slice(1).map((l, k) => l.baseline - b.lines[k].baseline)) : null;
    const mode = arr => [...arr.reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map())].sort((a, c) => c[1] - a[1])[0][0];
    const family = mode(b.lines.map(l => l.family));
    const weight = mode(b.lines.filter(l => l.family === family).map(l => l.weight));
    return { id: `T${i + 1}`, box, partial: b.lines.some(l => l.partial), sizeUnsure: b.lines.some(l => l.sizeUnsure),
      lines: b.lines.map(l => ({ text: l.text, box: l.box, baseline: l.baseline, x: l.originX, size: l.size, spacing: l.spacing })),
      fontCandidates: [...new Map(b.lines.flatMap(l => (l.fontCandidates || []).slice(0, 3)).map(c => [c.family, { familyId: c.family, family: library.find(f => f.id === c.family)?.name || c.family, score: c.score }])).values()].slice(0, 4),
      metrics: fontSummary.metrics?.[`${family}:${weight}`] || { ascent: 0.9, descent: 0.25 },
      color: hex(modeColor(b.lines.map(l => l.color), 6).color), family: library.find(f => f.id === family)?.name || family, familyId: family,
      weight, size: median(b.lines.map(l => l.size)), spacing: median(b.lines.map(l => l.spacing)),
      lineHeight: pitch ? Math.round(pitch) : null, align, inBox: container?.id || null, ocrConfidence: r1(Math.min(...b.lines.map(l => l.confidence))) };
  });
  for (const b of keptBoxes) b.contains = textBlocks.filter(t => t.inBox === b.id).map(t => t.id);
  for (const b of keptBoxes) {
    const texts = textBlocks.filter(t => t.inBox === b.id);
    const outerBg = sectionOf(b.box).bg.color;
    b.hint = texts.length === 1 && texts[0].lines.length === 1 && texts[0].align === 'center' && dist(b.fill, outerBg) > 30 ? 'button' :
      b.border && texts.length <= 1 && (!texts.length || texts[0].box[0] - b.box[0] <= 24) ? 'input / field' :
      texts.length >= 2 ? 'card / panel' : 'box';
    if (texts.length) {
      const t = union(texts.map(x => x.box));
      b.padding = { left: t[0] - b.box[0], top: t[1] - b.box[1], right: b.box[0] + b.box[2] - (t[0] + t[2]), bottom: b.box[1] + b.box[3] - (t[1] + t[3]) };
    }
  }

  // ---------- role guesses (hints only; the agent decides the real structure) ----------
  {
    const chars = t => t.lines.reduce((a, l) => a + l.text.length, 0);
    const weighted = textBlocks.flatMap(t => Array(Math.max(1, Math.round(chars(t) / 10))).fill(t.size)).sort((a, b) => a - b);
    const body = weighted[Math.floor(weighted.length / 2)] || 16;
    const headingSizes = [...new Set(textBlocks.filter(t => t.size >= body * 1.3).map(t => Math.round(t.size)))].sort((a, b) => b - a);
    const boxById = new Map(keptBoxes.map(b => [b.id, b]));
    for (const t of textBlocks) {
      const box = t.inBox && boxById.get(t.inBox);
      const words = t.lines[0].text.split(/\s+/).length;
      if (box?.hint === 'button') t.role = 'button label';
      else if (box?.hint === 'input / field') t.role = 'text inside an input (placeholder or value)';
      else if (t.size >= body * 1.3) t.role = `heading (level ${Math.min(3, headingSizes.indexOf(Math.round(t.size)) + 1)} by size)`;
      else if (t.lines.length === 1 && words <= 4 && keptBoxes.some(b => b.hint === 'input / field' && b.box[1] - (t.box[1] + t.box[3]) >= 0 && b.box[1] - (t.box[1] + t.box[3]) <= 24 && Math.abs(b.box[0] - t.box[0]) <= 24)) t.role = 'field label';
      else if (t.lines.length >= 2 && t.size <= body * 1.1) t.role = 'paragraph or list';
    }
    // a row of three or more short single-line items on one baseline is a menu
    const shorts = textBlocks.filter(t => !t.role && t.lines.length === 1 && t.lines[0].text.split(/\s+/).length <= 3);
    for (const t of shorts) {
      const row = shorts.filter(o => Math.abs(o.lines[0].baseline - t.lines[0].baseline) <= 2 && Math.abs(o.size - t.size) <= 2);
      if (row.length >= 3) for (const o of row) o.role = o.box[1] < H * 0.2 ? 'navigation link' : 'link or menu item in a row';
    }
    for (const t of textBlocks) if (!t.role && t.lines.length >= 2 && textBlocks.some(o => o !== t && Math.abs(o.box[0] - t.box[0]) <= 4 && o.lines.length >= 2 && Math.abs(o.size - t.size) <= 1)) t.role = 'list or column of links';
  }

  // ---------- palette ----------
  const palette = [];
  const addColor = (c, use) => { const h = typeof c === 'string' ? c : hex(c); const rgb = [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16));
    const found = palette.find(p => dist(p.rgb, rgb) <= 6); if (found) { found.uses.add(use); found.count++; } else palette.push({ hex: h, rgb, uses: new Set([use]), count: 1 }); };
  sections.forEach(s => addColor(s.bg.color, 'background'));
  textBlocks.forEach(t => addColor(t.color, 'text'));
  keptBoxes.forEach(b => addColor(b.fill, 'box fill'));
  palette.sort((a, b) => b.count - a.count);

  // ---------- fonts into the work folder ----------
  const usedFaces = new Map();
  for (const t of textBlocks) usedFaces.set(`${t.familyId}:${t.weight}`, { id: t.familyId, weight: t.weight });
  await fs.mkdir(path.join(dir, 'fonts'), { recursive: true });
  let fontCss = '';
  for (const { id, weight } of usedFaces.values()) {
    const f = library.find(x => x.id === id);
    const name = `${id}-${weight}.woff2`;
    await fs.copyFile(f.file(weight), path.join(dir, 'fonts', name));
    fontCss += `@font-face{font-family:'${f.name}';src:url('./fonts/${name}') format('woff2');font-weight:${weight};font-style:normal;font-display:block}\n`;
  }
  await fs.writeFile(path.join(dir, 'fonts.css'), fontCss);

  // ---------- section crops and annotated screenshot ----------
  for (const s of sections) if (s.y1 - s.y0 >= 4)
    await sharp(source).extract({ left: 0, top: s.y0, width: W, height: s.y1 - s.y0 }).png().toFile(path.join(dir, 'sections', `${s.id}.png`));
  const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const shapes = [];
  const draw = (id, box, color) => {
    shapes.push(`<rect x="${box[0] + 0.5}" y="${box[1] + 0.5}" width="${box[2]}" height="${box[3]}" fill="none" stroke="${color}" stroke-width="1.5"/>`);
    const lx = box[0], ly = Math.max(0, box[1] - 13);
    shapes.push(`<rect x="${lx}" y="${ly}" width="${id.length * 7 + 6}" height="13" fill="${color}"/><text x="${lx + 3}" y="${ly + 10}" font-family="Arial" font-size="11" font-weight="700" fill="#fff">${esc(id)}</text>`);
  };
  for (const s of sections) shapes.push(`<line x1="0" x2="${W}" y1="${s.y0 + 0.5}" y2="${s.y0 + 0.5}" stroke="#d00" stroke-dasharray="6 4"/><text x="${W - 40}" y="${s.y0 + 13}" font-family="Arial" font-size="12" font-weight="700" fill="#d00">${s.id}</text>`);
  for (const i of images) draw(i.id, i.box, '#e67700');
  for (const b of keptBoxes) draw(b.id, b.box, '#2b8a3e');
  for (const t of textBlocks) draw(t.id, t.box, '#1c7ed6');
  // last pass: a mark or icon that lies mostly inside a photo is part of the photo, whatever step produced it
  // (anything inside a detected photo is already in its crop or covered by its placeholder; gradients excluded)
  const inPhoto = box => images.some(i => i.kind !== 'gradient' && share(box, i.box) >= 0.5);
  for (let k = unread.length - 1; k >= 0; k--) if (inPhoto(unread[k].box)) unread.splice(k, 1);
  for (let k = keptIcons.length - 1; k >= 0; k--) if (inPhoto(keptIcons[k].box)) keptIcons.splice(k, 1);
  for (let k = unread.length - 1; k >= 0; k--) if (unread.some(o => o !== unread[k] && inside(unread[k].box, o.box, 2))) unread.splice(k, 1);
  unread.forEach((u, i) => { u.id = `U${i + 1}`; });
  for (const k of keptIcons) draw(k.id, k.box, '#ae3ec9');
  for (const r of rules) draw(r.id, r.box, '#495057');
  for (const u of unread) draw(u.id, u.box, '#f03e3e');
  await sharp(source).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${shapes.join('')}</svg>`), left: 0, top: 0 }])
    .png().toFile(path.join(dir, 'annotated.png'));

  // ---------- facts.json, facts.md, inventory for the evaluator ----------
  // an "icon" that is really a short word or a price: wider than tall, letter-sized, starting where a text line
  // just above or below it starts (a list column)
  const textLikeIcon = k => {
    const [x, y, w, h] = k.box;
    if (h < 7 || h > 22 || w < 1.3 * h) return null;
    const t = textBlocks.find(b => b.lines.some(l => Math.abs((l.x ?? l.box[0]) - x) <= 4 && (Math.abs(l.box[1] + l.box[3] - y) <= 2.5 * h || Math.abs(y + h - l.box[1]) <= 2.5 * h) && l.box[3] >= 0.6 * h && l.box[3] <= 1.6 * h));
    return t ? t.id : null;
  };
  // an unread mark that starts where a text column starts, right above or below one of its lines, is text OCR missed
  const textLikeMark = u => {
    const [x, y, w, h] = u.box;
    if (w < 2 * Math.min(h, 20) || h > 120) return null;
    // several columns items may line up (a heading above, a paragraph below): unread text is usually body text
    const t = textBlocks.filter(b => b.lines.some(l => Math.abs((l.x ?? l.box[0]) - x) <= 4 && Math.min(Math.abs(l.box[1] - (y + h)), Math.abs(y - (l.box[1] + l.box[3]))) <= 2 * l.box[3]))
      .sort((a, b) => a.size - b.size)[0];
    return t ? t.id : null;
  };
  const sectionFacts = sections.map(s => {
    const items = [
      ...textBlocks.filter(t => sectionOf(t.box) === s).map(t => ({ type: 'text', ...t })),
      ...keptBoxes.filter(b => sectionOf(b.box) === s).map(b => ({ type: 'box', id: b.id, box: b.box, fill: hex(b.fill), border: b.border, radius: b.radius, hint: b.hint, contains: b.contains, padding: b.padding })),
      ...images.filter(i => sectionOf(i.box) === s).map(i => ({ type: i.kind, id: i.id, box: i.box, file: i.file || null, route: i.route || null, gradient: i.gradient || null, behindText: i.behindText, stand: i.stand || null, radius: i.radius || 0 })),
      ...keptIcons.filter(k => sectionOf(k.box) === s).map(k => ({ type: 'icon', id: k.id, box: k.box, fileBox: k.fileBox, file: k.file, color: k.color, lucide: k.lucide, textLike: textLikeIcon(k) })),
      ...rules.filter(r => sectionOf(r.box) === s).map(r => ({ type: 'line', id: r.id, box: r.box, color: r.color })),
      ...unread.filter(u => sectionOf(u.box) === s).map(u => ({ type: 'unread', id: u.id, box: u.box, color: u.color, textLike: textLikeMark(u) })),
    ].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
    const content = items.filter(i => i.type !== 'line' || i.box[2] < W * 0.9).map(i => i.box);
    return { id: s.id, y: s.y0, height: s.y1 - s.y0, background: s.bg.kind === 'flat' ? hex(s.bg.color) : s.bg, continued: s.continued,
      contentLeft: content.length ? Math.min(...content.map(b => b[0])) : null, contentRight: content.length ? Math.max(...content.map(b => b[0] + b[2])) : null, items };
  });
  const facts = { viewport: { width: W, height: H }, screenshot: source,
    fonts: { display: library.find(f => f.id === fontSummary.displayFamily)?.name, body: library.find(f => f.id === fontSummary.bodyFamily)?.name,
      faces: [...usedFaces.values()].map(f => ({ family: library.find(x => x.id === f.id).name, weight: f.weight })) },
    palette: palette.map(p => ({ hex: p.hex, uses: [...p.uses] })), sections: sectionFacts,
    supplied: catalog.map(a => ({ path: a.path, width: a.width, height: a.height })),
    timingsMs: { ...times, total: Math.round(performance.now() - started) } };
  await fs.writeFile(path.join(dir, 'facts.json'), JSON.stringify(facts, null, 2) + '\n');
  await fs.writeFile(path.join(dir, 'facts.md'), factsMarkdown(facts));
  const inventory = { schemaVersion: '1.0', source: { screenshot: path.relative(dir, source).replaceAll('\\', '/'), viewport: { width: W, height: H }, brief: '' },
    regions: sections.map(s => ({ id: s.id, role: 'section', bounds: [0, s.y0, W, s.y1 - s.y0], parentId: null, confidence: 0.8 })),
    elements: [...textBlocks.map(t => ({ id: t.id, parentId: sectionOf(t.box).id, kind: 'text', role: 'text', bounds: t.box, confidence: 0.8, evidence: 'observed', text: t.lines.map(l => l.text).join('\n') })),
      ...images.filter(i => i.kind === 'image').map(i => ({ id: `${i.id}-el`, parentId: sectionOf(i.box).id, kind: 'media', role: 'image', bounds: i.box, confidence: 0.7, evidence: 'observed', assetId: i.id })),
      ...keptIcons.map(k => ({ id: `${k.id}-el`, parentId: sectionOf(k.box).id, kind: 'icon', role: 'icon', bounds: k.box, confidence: 0.6, evidence: 'observed', assetId: k.id }))],
    assets: [...images.filter(i => i.kind === 'image').map(i => ({ id: i.id, elementId: `${i.id}-el`, kind: 'image', confidence: 0.7, evidence: 'Busy region in the screenshot.', route: i.file ? 'extract' : 'unresolved', resolvedPath: i.file || null, description: i.route })),
      ...keptIcons.map(k => ({ id: k.id, elementId: `${k.id}-el`, kind: 'icon', confidence: 0.6, evidence: 'Small mark in the screenshot.', route: 'extract', resolvedPath: k.file, description: `icon, Lucide guess ${k.lucide.join(', ')}` }))],
    unknowns: [] };
  await fs.writeFile(path.join(dir, 'page-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  return { facts: path.join(dir, 'facts.md'), annotated: path.join(dir, 'annotated.png'), sections: sections.length, textBlocks: textBlocks.length,
    boxes: keptBoxes.length, images: images.length, icons: keptIcons.length, timingsMs: facts.timingsMs };
}

const bx = b => `x ${b[0]}, y ${b[1]}, ${b[2]}×${b[3]}`;
export function factsMarkdown(facts) {
  const L = [];
  L.push(`# Page facts`, ``, `Viewport ${facts.viewport.width}×${facts.viewport.height}. Boxes are screenshot pixels: x, y (page top-left), width×height.`, ``,
    `**Role hints** ("looks like: …") are guesses from layout and size, to save you time. Decide the real structure and semantics yourself.`, ``,
    `**How to read text items.** Baselines, x positions and boxes use PAGE coordinates at the reference viewport. Never reuse page y as a section-relative top. Font families, sizes, wording, roles and image boundaries are estimates: visually reconcile them once before coding. Build shared containers and responsive components from relationships. The checker reports observations and does not change fonts.`, ``);
  L.push(`## Fonts`, ``, `Display: ${facts.fonts.display}. Body: ${facts.fonts.body}. Already in the site as @font-face (src/fonts.css):`);
  for (const f of facts.fonts.faces) L.push(`- "${f.family}" weight ${f.weight}`);
  if (facts.supplied?.length) {
    L.push(``, `## Supplied originals`, ``, `Prefer the matching original after visual confirmation. Extracted crops are candidates and may merge multiple components or include margins.`);
    for (const a of facts.supplied) L.push(`- ${a.path} (${a.width}×${a.height})`);
  }
  L.push(``, `## Palette`, ``);
  for (const p of facts.palette.slice(0, 16)) L.push(`- ${p.hex} — ${p.uses.join(', ')}`);
  L.push(``, `## Sections (top to bottom)`, ``);
  for (const s of facts.sections) {
    const bg = typeof s.background === 'string' ? s.background : s.background.scene ? 'a full-width photo (see its image item below; text sits on top of it)' : `mixed (photo or gradient) — edges: top ${s.background.top}, bottom ${s.background.bottom}, left ${s.background.left}, right ${s.background.right}`;
    L.push(`### ${s.id} — y ${s.y} to ${s.y + s.height} (height ${s.height}px)${s.continued ? ' — same background as the section above' : ''}`, ``,
      `Background ${bg}. Content from x ${s.contentLeft ?? '-'} to x ${s.contentRight ?? '-'}.`, ``);
    for (const it of s.items) {
      if (it.type === 'text') {
        const font = `"${it.family}" ${it.weight}, ${it.sizeUnsure ? '≈' : ''}${it.size}px${it.spacing ? `, letter-spacing ${it.spacing}px` : ''}${it.lineHeight ? `, line spacing ${it.lineHeight}px (baseline to baseline)` : ''}`;
        const note = it.partial ? ` — PARTLY READ: correct wording in the review plan; its geometry may also be incomplete` : it.ocrConfidence < 0.75 ? ` — OCR unsure: check the wording in sections/${s.id}.png` : '';
        L.push(`- **${it.id}** text${it.role ? ` (looks like: ${it.role})` : ''} — ${font} — color ${it.color} — align ${it.align}${it.inBox ? ` — inside ${it.inBox}` : ''}${note}`);
        for (const l of it.lines) L.push(`  - "${l.text}" — baseline y ${l.baseline}, starts x ${l.x}, ink width ${l.box[2]}`);
      } else if (it.type === 'box') {
        const border = !it.border ? 'no border' : typeof it.border === 'string' ? `border ${it.border}` : Object.entries(it.border).map(([k, v]) => `border-${k} ${v}`).join(', ');
        const pad = it.padding ? ` — text inset left ${it.padding.left}, top ${it.padding.top}` : '';
        L.push(`- **${it.id}** box (looks like ${it.hint}) — ${bx(it.box)} — fill ${it.fill} — ${border} — radius ${it.radius}px${it.contains.length ? ` — contains ${it.contains.join(', ')}` : ''}${pad}`);
      } else if (it.type === 'image') {
        L.push(`- **${it.id}** image — ${bx(it.box)} — ${it.file ? `candidate \`${it.file}\` (${it.route}); reference size only, adapt within its component` : `${it.route}; record an unresolved asset and sized placeholder`}`);
      } else if (it.type === 'gradient') {
        const g = it.gradient;
        L.push(`- **${it.id}** gradient area — ${bx(it.box)} — ${it.stand ? `linear-gradient(${it.stand.direction}, ${it.stand.colors.join(', ')})` : `top ${g.top}, bottom ${g.bottom}`}${it.radius ? `, radius ${it.radius}px` : ''} (CSS gradient)`);
      } else if (it.type === 'icon') {
        L.push(it.textLike
          ? `- **${it.id}** probably text, not an icon (letter-sized, lined up with ${it.textLike}) — ${bx(it.box)} — color ${it.color} — if sections/${s.id}.png shows characters here, write them as text styled like ${it.textLike}; otherwise place \`${it.file}\` as <img> at ${bx(it.fileBox || it.box)}`
          : `- **${it.id}** icon — place \`${it.file}\` as <img> at ${bx(it.fileBox || it.box)} — color ${it.color} — Lucide look-alikes: ${it.lucide.join(', ')}`);
      } else if (it.type === 'line') {
        L.push(`- **${it.id}** line — ${bx(it.box)} — color ${it.color}`);
      } else if (it.type === 'unread') {
        if (it.textLike) L.push(`- **${it.id}** text OCR could not read (lined up with ${it.textLike}) — ${bx(it.box)} — ink ${it.color} — write the wording you see in sections/${s.id}.png here, styled like ${it.textLike}, breaking lines where the screenshot does`);
        else L.push(`- ${it.id} small unmeasured mark — ${bx(it.box)} — ink ${it.color} — default: ignore it. Only if sections/${s.id}.png clearly shows words here, write them as text styled like the nearest text item. Never draw a box, shape or image for it.`);
      }
    }
    L.push(``);
  }
  return L.join('\n');
}
