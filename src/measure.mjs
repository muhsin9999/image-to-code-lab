import path from 'node:path';
import { createRequire } from 'node:module';
import { boxOf, resolveDependency } from './common.mjs';

const require = createRequire(import.meta.url);
const sharp = require(resolveDependency('sharp'));

function number(value, name, fallback) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
  return n;
}

function hex(rgb) { return `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`; }

function strongestEdges(start, end, read, threshold, maxEdges) {
  const candidates = [];
  for (let i = start + 1; i < end; i++) {
    const a = read(i - 1), b = read(i);
    const delta = a.reduce((sum, v, c) => sum + Math.abs(v - b[c]), 0);
    if (delta >= threshold) candidates.push({ at: i, delta });
  }
  const selected = [];
  for (const candidate of candidates.sort((a, b) => b.delta - a.delta)) {
    if (selected.every(edge => Math.abs(edge.at - candidate.at) > 6)) selected.push(candidate);
    if (selected.length >= maxEdges) break;
  }
  return selected.sort((a, b) => a.at - b.at);
}

export async function measureScreenshot({ screenshot, box, points, row, column, ink, inkThreshold, edgeThreshold, maxEdges }) {
  const started = performance.now();
  const source = path.resolve(screenshot);
  const { data, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const rect = box ? boxOf(box) : [0, 0, width, height];
  const [x0, y0, w, h] = rect;
  if (x0 + w > width || y0 + h > height) throw new Error('Measurement box extends outside screenshot.');
  const pixel = (x, y) => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) throw new Error(`Point ${x},${y} is outside screenshot.`);
    const i = (y * width + x) * channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const out = { source, width, height, box: rect };
  if (points) {
    out.samples = String(points).split(';').map(part => {
      const pair = part.split(',').map(Number);
      if (pair.length !== 2 || pair.some(n => !Number.isInteger(n))) throw new Error('--points must be x,y;x,y.');
      const rgb = pixel(pair[0], pair[1]);
      return { x: pair[0], y: pair[1], rgb, hex: hex(rgb) };
    });
  }
  const minEdge = number(edgeThreshold, '--edge-threshold', 40);
  const limit = number(maxEdges, '--max-edges', 24);
  if (minEdge < 0 || limit < 1 || limit > 200) throw new Error('Invalid edge threshold or max edges.');
  if (row !== undefined) {
    const y = number(row, '--row');
    if (!Number.isInteger(y) || y < y0 || y >= y0 + h) throw new Error('--row must lie inside --box.');
    out.rowEdges = strongestEdges(x0, x0 + w, x => pixel(x, y), minEdge, limit);
  }
  if (column !== undefined) {
    const x = number(column, '--column');
    if (!Number.isInteger(x) || x < x0 || x >= x0 + w) throw new Error('--column must lie inside --box.');
    out.columnEdges = strongestEdges(y0, y0 + h, y => pixel(x, y), minEdge, limit);
  }
  if (ink !== undefined) {
    if (!['dark', 'light'].includes(ink)) throw new Error('--ink must be dark or light.');
    const threshold = number(inkThreshold, '--ink-threshold', 150);
    if (threshold < 0 || threshold > 255) throw new Error('--ink-threshold must be 0–255.');
    const rows = [];
    for (let y = y0; y < y0 + h; y++) {
      let count = 0, minX = width, maxX = -1;
      for (let x = x0; x < x0 + w; x++) {
        const rgb = pixel(x, y);
        const luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
        if (ink === 'dark' ? luminance < threshold : luminance > threshold) {
          count++; minX = Math.min(minX, x); maxX = x;
        }
      }
      if (count) rows.push({ y, count, minX, maxX });
    }
    const groups = [];
    for (const item of rows) {
      const last = groups.at(-1);
      if (last && item.y - last.y1 <= 2) {
        last.y1 = item.y; last.minX = Math.min(last.minX, item.minX); last.maxX = Math.max(last.maxX, item.maxX); last.pixels += item.count;
      } else groups.push({ y0: item.y, y1: item.y, minX: item.minX, maxX: item.maxX, pixels: item.count });
    }
    out.inkBands = groups;
  }
  out.elapsedMs = Math.round(performance.now() - started);
  return out;
}
