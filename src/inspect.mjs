import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveDependency } from './common.mjs';

const require = createRequire(import.meta.url);
const sharp = require(resolveDependency('sharp'));

function hex([r, g, b]) { return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`; }

export async function inspectScreenshot(file) {
  const start = performance.now();
  const input = path.resolve(file);
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height) throw new Error('Cannot read screenshot dimensions.');
  const sampleHeight = Math.min(meta.height, 1024);
  const { data, info } = await sharp(input).removeAlpha().resize(128, sampleHeight, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const counts = new Map();
  const rows = [];
  for (let y = 0; y < info.height; y++) {
    const sum = [0, 0, 0];
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      const rgb = [data[i], data[i + 1], data[i + 2]];
      for (let c = 0; c < 3; c++) sum[c] += rgb[c];
      const key = rgb.map(v => Math.min(255, Math.round(v / 24) * 24)).join(',');
      const bucket = counts.get(key) || { pixels: 0, sum: [0, 0, 0] };
      bucket.pixels++;
      for (let c = 0; c < 3; c++) bucket.sum[c] += rgb[c];
      counts.set(key, bucket);
    }
    rows.push(sum.map(v => v / info.width));
  }
  const palette = [...counts.values()].sort((a, b) => b.pixels - a.pixels).slice(0, 8).map(bucket => ({
    color: hex(bucket.sum.map(sum => Math.round(sum / bucket.pixels))),
    fraction: Math.round(1000 * bucket.pixels / (info.width * info.height)) / 1000,
  }));
  const jumps = [];
  for (let y = 1; y < rows.length; y++) {
    const delta = rows[y].reduce((sum, value, c) => sum + Math.abs(value - rows[y - 1][c]), 0) / 3;
    jumps.push({ y: Math.round(y * meta.height / sampleHeight), delta });
  }
  const separators = [];
  for (const item of jumps.filter(row => row.delta >= 10).sort((a, b) => b.delta - a.delta)) {
    if (separators.every(previous => Math.abs(previous.y - item.y) > 8)) separators.push(item);
    if (separators.length === 8) break;
  }
  separators.sort((a, b) => a.y - b.y);
  return {
    source: input,
    width: meta.width,
    height: meta.height,
    aspectRatio: Math.round(1000 * meta.width / meta.height) / 1000,
    format: meta.format,
    hasAlpha: meta.hasAlpha || false,
    dominantColors: palette,
    horizontalColorChanges: separators,
    note: 'Color changes are geometry hints. A vision agent must still identify elements, text, and semantics.',
    elapsedMs: Math.round(performance.now() - start),
  };
}
