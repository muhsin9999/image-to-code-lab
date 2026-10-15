import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveDependency } from './common.mjs';

const require = createRequire(import.meta.url);
const sharp = require(resolveDependency('sharp'));

// Tesseract can put two columns on one line. Keep its original result, but give
// the vision pass smaller spatial groups with their own boxes.
export function splitOcrLines(lines = [], words = []) {
  const result = [];
  for (const line of lines) {
    const [lx, ly, lw, lh] = line.bounds;
    const cy = ly + lh / 2;
    const parts = words.filter(word => {
      const [x, y, w, h] = word.bounds;
      return x >= lx - 3 && x + w <= lx + lw + 3 && Math.abs(y + h / 2 - cy) <= Math.max(6, lh * .55);
    }).sort((a, b) => a.bounds[0] - b.bounds[0]);
    if (!parts.length) { result.push(line); continue; }
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const x = Math.min(...group.map(item => item.bounds[0]));
      const y = Math.min(...group.map(item => item.bounds[1]));
      const right = Math.max(...group.map(item => item.bounds[0] + item.bounds[2]));
      const bottom = Math.max(...group.map(item => item.bounds[1] + item.bounds[3]));
      result.push({ text: group.map(item => item.text).join(' '), bounds: [x, y, right - x, bottom - y],
        confidence: Math.round(100 * group.reduce((sum, item) => sum + item.confidence, 0) / group.length) / 100 });
      group = [];
    };
    for (const word of parts) {
      const previous = group.at(-1);
      if (previous && word.bounds[0] - previous.bounds[0] - previous.bounds[2] > Math.max(24, 2.2 * Math.max(lh, word.bounds[3]))) flush();
      group.push(word);
    }
    flush();
  }
  return result;
}

function flatColor(data, info, bounds) {
  if (!Array.isArray(bounds)) return null;
  const [x, y, width, height] = bounds.map(Math.round);
  if (width < 8 || height < 6) return null;
  const counts = new Map();
  for (let row = 1; row <= 9; row++) for (let col = 1; col <= 9; col++) {
    const px = Math.max(0, Math.min(info.width - 1, Math.round(x + width * col / 10)));
    const py = Math.max(0, Math.min(info.height - 1, Math.round(y + height * row / 10)));
    const offset = (py * info.width + px) * info.channels;
    const rgb = [data[offset], data[offset + 1], data[offset + 2]];
    const bucket = rgb.map(channel => Math.round(channel / 16)).join(',');
    const item = counts.get(bucket) || { count: 0, sum: [0, 0, 0] };
    item.count++;
    rgb.forEach((channel, index) => { item.sum[index] += channel; });
    counts.set(bucket, item);
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  if (!best || best.count < 55) return null;
  const color = `#${best.sum.map(sum => Math.round(sum / best.count).toString(16).padStart(2, '0')).join('')}`;
  return { color, coverage: Math.round(100 * best.count / 81) / 100 };
}

function usableCssFill(value) {
  if (typeof value !== 'string') return false;
  return /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|(?:linear|radial)-gradient\(|transparent$|white$|black$)/i.test(value.trim());
}

function rgbAt(data, info, x, y) {
  const offset = (Math.max(0, Math.min(info.height - 1, y)) * info.width + Math.max(0, Math.min(info.width - 1, x))) * info.channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
}

function borderColor(data, info, bounds) {
  const [x, y, width, height] = bounds.map(Math.round);
  if (width < 25 || height < 20 || x < 1 || y < 1 || x + width >= info.width || y + height >= info.height) return null;
  const points = [.2, .4, .6, .8].map(fraction => Math.round(x + width * fraction));
  const edges = points.map(px => rgbAt(data, info, px, y));
  const inside = points.map(px => rgbAt(data, info, px, y + 3));
  const mean = rows => [0, 1, 2].map(channel => Math.round(rows.reduce((sum, row) => sum + row[channel], 0) / rows.length));
  const edge = mean(edges), inner = mean(inside);
  const spread = Math.max(...edges.flatMap(row => row.map((value, channel) => Math.abs(value - edge[channel]))));
  const contrast = Math.max(...edge.map((value, channel) => Math.abs(value - inner[channel])));
  if (spread > 12 || contrast < 12) return null;
  return `1px solid #${edge.map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

/** Add only high-confidence flat fills. Never replace a designer/agent choice. */
export async function enrichInventoryColors(inventory, screenshot) {
  const { data, info } = await sharp(path.resolve(screenshot)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const applied = [];
  for (const item of [...(inventory.regions || []), ...(inventory.elements || [])]) {
    if (!item.bounds) continue;
    if (item.kind && !['control', 'media', 'icon', 'decoration', 'container'].includes(item.kind)) continue;
    const existing = item.style?.background;
    const fill = usableCssFill(existing) ? null : flatColor(data, info, item.bounds);
    if (fill) {
      item.style = { ...item.style, background: fill.color };
      applied.push({ id: item.id, background: fill.color, coverage: fill.coverage });
    } else if (existing && !usableCssFill(existing)) {
      item.style = { ...item.style, backgroundDescription: existing };
      delete item.style.background;
    }
    if (item.kind === 'control' && /input|field|textarea|select|button|submit|search/i.test(item.role || '') && !item.style?.border) {
      const border = borderColor(data, info, item.bounds);
      if (border) { item.style = { ...item.style, border }; applied.push({ id: item.id, border }); }
    }
    if (item.kind === 'control' && !item.style?.color && /^#[0-9a-f]{6}$/i.test(item.style?.background || '')) {
      const rgb = [1, 3, 5].map(index => parseInt(item.style.background.slice(index, index + 2), 16));
      if (rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < 100)
        item.style.color = '#ffffff';
    }
  }
  return applied;
}

/** Inventory of supplied originals; selection still requires visual confirmation. */
export async function catalogAssets(directory, relativeTo) {
  if (!directory) return [];
  const root = path.resolve(directory);
  const allowed = /\.(png|jpe?g|webp|avif|svg|gif)$/i;
  const found = [];
  async function visit(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) { if (found.length < 500) await visit(file); continue; }
      if (!entry.isFile() || !allowed.test(entry.name) || found.length >= 500) continue;
      const metadata = await sharp(file).metadata().catch(() => null);
      if (!metadata?.width || !metadata?.height) continue;
      found.push({ path: path.relative(relativeTo, file).replaceAll('\\', '/'), name: entry.name,
        width: metadata.width, height: metadata.height, format: metadata.format });
    }
  }
  await visit(root);
  return found;
}

/** A single visual index lets the vision pass match supplied originals in one look. */
export async function makeAssetContactSheet(catalog, relativeTo, output) {
  if (!catalog.length) return null;
  const shown = catalog.slice(0, 48);
  const cellWidth = 180, cellHeight = 140, columns = Math.min(6, shown.length);
  const rows = Math.ceil(shown.length / columns);
  const tiles = await Promise.all(shown.map(async (asset, index) => {
    const image = await sharp(path.resolve(relativeTo, asset.path)).resize(164, 105, {
      fit: 'contain', background: '#f4f4f4' }).flatten({ background: '#f4f4f4' }).png().toBuffer();
    const label = Buffer.from(`<svg width="180" height="28" xmlns="http://www.w3.org/2000/svg"><rect width="180" height="28" fill="#eeeeee"/><text x="8" y="19" font-size="14" font-family="Arial" fill="#111111">${index + 1}</text></svg>`);
    const tile = await sharp({ create: { width: cellWidth, height: cellHeight, channels: 3, background: '#ffffff' } })
      .composite([{ input: image, left: 8, top: 5 }, { input: label, left: 0, top: 112 }]).png().toBuffer();
    return { input: tile, left: index % columns * cellWidth, top: Math.floor(index / columns) * cellHeight };
  }));
  await sharp({ create: { width: columns * cellWidth, height: rows * cellHeight, channels: 3, background: '#dddddd' } })
    .composite(tiles).png().toFile(output);
  return { path: output, shown: shown.length, omitted: catalog.length - shown.length };
}
