import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { boxOf, resolveDependency } from './common.mjs';
import { recognizeText } from './ocr.mjs';

const require = createRequire(import.meta.url);
const sharp = require(resolveDependency('sharp'));
const imageOps = new Set(['crop', 'resize', 'grayscale', 'threshold', 'invert']);
const analysisOps = new Set(['sample', 'palette', 'projection', 'components', 'edges', 'stats', 'grid', 'ocr']);

function fail(message) { throw new Error(`Recipe: ${message}`); }
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}
function hex(rgb) { return `#${rgb.map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`; }
function pixel(image, x, y) {
  integer(x, 'x', 0, image.width - 1); integer(y, 'y', 0, image.height - 1);
  const i = (y * image.width + x) * image.channels;
  return image.channels === 1 ? [image.data[i], image.data[i], image.data[i]] : [image.data[i], image.data[i + 1], image.data[i + 2]];
}
function luminance(rgb) { return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]; }
function sourceBox(image, bounds) {
  return bounds.map((value, i) => Math.round(i < 2 ? image.origin[i] + value * image.scale[i] : value * image.scale[i - 2]));
}
function bitmapResult(image) {
  return { kind: 'image', width: image.width, height: image.height, channels: image.channels,
    sourceBox: sourceBox(image, [0, 0, image.width, image.height]) };
}
function maskAt(image, x, y) { return image.data[(y * image.width + x) * image.channels] > 0; }

async function imageStep(step, image) {
  const { width, height, channels } = image;
  if (step.op === 'crop') {
    const [x, y, w, h] = boxOf(step.box, 'crop box');
    if (x + w > width || y + h > height) fail('crop extends outside its input.');
    const data = Buffer.alloc(w * h * channels);
    for (let row = 0; row < h; row++) image.data.copy(data, row * w * channels, ((y + row) * width + x) * channels, ((y + row) * width + x + w) * channels);
    return { data, width: w, height: h, channels, origin: [image.origin[0] + x * image.scale[0], image.origin[1] + y * image.scale[1]], scale: image.scale };
  }
  if (step.op === 'resize') {
    const targetWidth = integer(step.width, 'resize width', 1, 4096);
    const targetHeight = integer(step.height, 'resize height', 1, 4096);
    const { data, info } = await sharp(image.data, { raw: { width, height, channels } }).resize(targetWidth, targetHeight, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels, origin: image.origin,
      scale: [image.scale[0] * width / info.width, image.scale[1] * height / info.height] };
  }
  if (step.op === 'grayscale') {
    const data = Buffer.alloc(width * height);
    for (let i = 0; i < width * height; i++) data[i] = Math.round(luminance(pixel(image, i % width, Math.floor(i / width))));
    return { ...image, data, channels: 1 };
  }
  if (step.op === 'threshold') {
    const mode = step.mode ?? 'dark';
    if (!['dark', 'light', 'color'].includes(mode)) fail('threshold mode must be dark, light, or color.');
    const value = step.value ?? 150;
    if (mode !== 'color' && (typeof value !== 'number' || value < 0 || value > 255)) fail('threshold value must be 0–255.');
    const match = /^#?([\da-f]{6})$/i.exec(step.color ?? '');
    if (mode === 'color' && !match) fail('color threshold needs a six-digit hex color.');
    const key = match ? [0, 2, 4].map(i => parseInt(match[1].slice(i, i + 2), 16)) : null;
    const tolerance = step.tolerance ?? 28;
    const data = Buffer.alloc(width * height);
    for (let i = 0; i < data.length; i++) {
      const rgb = pixel(image, i % width, Math.floor(i / width));
      data[i] = (mode === 'dark' ? luminance(rgb) < value : mode === 'light' ? luminance(rgb) > value :
        Math.max(...rgb.map((c, j) => Math.abs(c - key[j]))) <= tolerance) ? 255 : 0;
    }
    return { ...image, data, channels: 1 };
  }
  if (step.op === 'invert') {
    const data = Buffer.from(image.data);
    for (let i = 0; i < data.length; i++) data[i] = 255 - data[i];
    return { ...image, data };
  }
  fail(`unknown image operation ${step.op}.`);
}

function analysisStep(step, image) {
  const { width, height } = image;
  if (step.op === 'sample') {
    if (!Array.isArray(step.points) || step.points.length > 200) fail('sample needs up to 200 points.');
    return step.points.map(point => {
      if (!Array.isArray(point) || point.length !== 2) fail('sample point must be [x,y].');
      const rgb = pixel(image, ...point);
      return { point, sourcePoint: sourceBox(image, [point[0], point[1], 0, 0]).slice(0, 2), rgb, hex: hex(rgb) };
    });
  }
  if (step.op === 'palette') {
    const bins = new Map(), stride = Math.max(1, Math.ceil(width * height / 200000));
    for (let i = 0; i < width * height; i += stride) {
      const rgb = pixel(image, i % width, Math.floor(i / width));
      const key = rgb.map(c => Math.round(c / 24)).join(',');
      const bucket = bins.get(key) ?? { count: 0, sum: [0, 0, 0] };
      bucket.count++;
      for (let c = 0; c < 3; c++) bucket.sum[c] += rgb[c];
      bins.set(key, bucket);
    }
    return [...bins.values()].sort((a, b) => b.count - a.count).slice(0, integer(step.top ?? 8, 'palette top', 1, 32))
      .map(bucket => ({ color: hex(bucket.sum.map(v => v / bucket.count)), fraction: Math.round(1000 * bucket.count * stride / (width * height)) / 1000 }));
  }
  if (step.op === 'stats') {
    const sum = [0, 0, 0], sumSq = [0, 0, 0], stride = Math.max(1, Math.ceil(width * height / 200000));
    let count = 0;
    for (let i = 0; i < width * height; i += stride) {
      const rgb = pixel(image, i % width, Math.floor(i / width)); count++;
      for (let c = 0; c < 3; c++) { sum[c] += rgb[c]; sumSq[c] += rgb[c] ** 2; }
    }
    const mean = sum.map(v => v / count), deviation = sumSq.map((v, c) => Math.sqrt(Math.max(0, v / count - mean[c] ** 2)));
    return { meanRgb: mean.map(Math.round), meanHex: hex(mean), channelDeviation: deviation.map(v => Math.round(v * 10) / 10) };
  }
  if (step.op === 'grid') {
    const columns = integer(step.columns ?? 8, 'grid columns', 1, 32);
    const rows = integer(step.rows ?? 6, 'grid rows', 1, 32);
    const cells = [];
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const x0 = Math.floor(column * width / columns), y0 = Math.floor(row * height / rows);
      const x1 = Math.floor((column + 1) * width / columns), y1 = Math.floor((row + 1) * height / rows);
      const stride = Math.max(1, Math.ceil(Math.sqrt((x1 - x0) * (y1 - y0) / 500)));
      const sum = [0, 0, 0], sq = [0, 0, 0]; let count = 0;
      for (let y = y0; y < y1; y += stride) for (let x = x0; x < x1; x += stride) {
        const rgb = pixel(image, x, y); count++;
        for (let c = 0; c < 3; c++) { sum[c] += rgb[c]; sq[c] += rgb[c] ** 2; }
      }
      const mean = sum.map(v => v / count);
      const deviation = sq.map((v, c) => Math.sqrt(Math.max(0, v / count - mean[c] ** 2)));
      const bounds = [x0, y0, x1 - x0, y1 - y0];
      cells.push({ row, column, bounds, sourceBounds: sourceBox(image, bounds), color: hex(mean),
        colorVariation: Math.round(deviation.reduce((a, b) => a + b, 0) / 3) });
    }
    return cells;
  }
  if (step.op === 'projection') {
    if (image.channels !== 1) fail('projection requires a threshold mask.');
    const axis = step.axis ?? 'y';
    if (!['x', 'y'].includes(axis)) fail('projection axis must be x or y.');
    const length = axis === 'y' ? height : width;
    const other = axis === 'y' ? width : height;
    const minCount = integer(step.minCount ?? Math.max(1, Math.round(other * 0.002)), 'projection minCount', 1);
    const maxGap = integer(step.maxGap ?? 2, 'projection maxGap', 0, 100);
    const groups = [];
    let active = null;
    for (let at = 0; at < length; at++) {
      let count = 0, min = other, max = -1;
      for (let cross = 0; cross < other; cross++) {
        const x = axis === 'y' ? cross : at, y = axis === 'y' ? at : cross;
        if (maskAt(image, x, y)) { count++; min = Math.min(min, cross); max = cross; }
      }
      if (count < minCount) continue;
      if (active && at - active.end <= maxGap + 1) { active.end = at; active.min = Math.min(active.min, min); active.max = Math.max(active.max, max); active.pixels += count; }
      else { active = { start: at, end: at, min, max, pixels: count }; groups.push(active); }
    }
    return groups.map(group => {
      const bounds = axis === 'y' ? [group.min, group.start, group.max - group.min + 1, group.end - group.start + 1] :
        [group.start, group.min, group.end - group.start + 1, group.max - group.min + 1];
      return { bounds, sourceBounds: sourceBox(image, bounds), pixels: group.pixels };
    }).slice(0, integer(step.top ?? 200, 'projection top', 1, 500));
  }
  if (step.op === 'components') {
    if (image.channels !== 1) fail('components requires a threshold mask.');
    if (width * height > 4000000) fail('components input exceeds 4 million pixels; crop or resize first.');
    const seen = new Uint8Array(width * height), queue = new Int32Array(width * height), results = [];
    const minArea = integer(step.minArea ?? 8, 'components minArea', 1);
    for (let i = 0; i < seen.length; i++) {
      if (seen[i] || !image.data[i]) continue;
      let head = 0, tail = 0, area = 0, minX = width, minY = height, maxX = 0, maxY = 0;
      queue[tail++] = i; seen[i] = 1;
      while (head < tail) {
        const point = queue[head++], x = point % width, y = Math.floor(point / width);
        area++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (const next of [x ? point - 1 : -1, x < width - 1 ? point + 1 : -1, y ? point - width : -1, y < height - 1 ? point + width : -1]) {
          if (next >= 0 && !seen[next] && image.data[next]) { seen[next] = 1; queue[tail++] = next; }
        }
      }
      if (area >= minArea) { const bounds = [minX, minY, maxX - minX + 1, maxY - minY + 1]; results.push({ bounds, sourceBounds: sourceBox(image, bounds), area }); }
    }
    return results.sort((a, b) => b.area - a.area).slice(0, integer(step.top ?? 100, 'components top', 1, 500));
  }
  if (step.op === 'edges') {
    const axis = step.axis ?? 'y';
    if (!['x', 'y'].includes(axis)) fail('edges axis must be x or y.');
    const length = axis === 'y' ? height : width, crossLength = axis === 'y' ? width : height;
    const stride = Math.max(1, Math.ceil(crossLength / 256)), profile = [];
    for (let at = 0; at < length; at++) {
      const sum = [0, 0, 0]; let count = 0;
      for (let cross = 0; cross < crossLength; cross += stride) {
        const rgb = axis === 'y' ? pixel(image, cross, at) : pixel(image, at, cross);
        count++; for (let c = 0; c < 3; c++) sum[c] += rgb[c];
      }
      profile.push(sum.map(v => v / count));
    }
    const candidates = [];
    for (let at = 1; at < length; at++) {
      const delta = profile[at].reduce((sum, v, c) => sum + Math.abs(v - profile[at - 1][c]), 0) / 3;
      if (delta >= (step.minDelta ?? 10)) candidates.push({ at, sourceAt: Math.round(image.origin[axis === 'y' ? 1 : 0] + at * image.scale[axis === 'y' ? 1 : 0]), delta: Math.round(delta * 10) / 10 });
    }
    const selected = [];
    for (const item of candidates.sort((a, b) => b.delta - a.delta)) {
      if (selected.every(previous => Math.abs(previous.at - item.at) > (step.minGap ?? 8))) selected.push(item);
      if (selected.length >= integer(step.top ?? 16, 'edges top', 1, 100)) break;
    }
    return selected.sort((a, b) => a.at - b.at);
  }
  fail(`unknown analysis operation ${step.op}.`);
}

async function ocrStep(step, image) {
  const png = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: image.channels } }).png().toBuffer();
  const result = await recognizeText(png, { minConfidence: step.minConfidence ?? 50, language: step.language ?? 'eng' });
  return { ...result, lines: result.lines.map(item => ({ ...item, sourceBounds: sourceBox(image, item.bounds) })),
    words: result.words.map(item => ({ ...item, sourceBounds: sourceBox(image, item.bounds) })) };
}

export async function runRecipe(spec) {
  if (!spec || typeof spec !== 'object' || !spec.image || !Array.isArray(spec.steps)) fail('provide image and steps.');
  if (spec.steps.length > 32) fail('maximum 32 steps.');
  const source = path.resolve(spec.image);
  const { data, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width * info.height > 25000000) fail('image exceeds 25 million pixels.');
  const values = new Map([['source', { data, width: info.width, height: info.height, channels: info.channels, origin: [0, 0], scale: [1, 1] }]]);
  const results = [];
  for (const step of spec.steps) {
    if (!step || typeof step.id !== 'string' || !/^[\w-]+$/.test(step.id) || values.has(step.id)) fail('each step needs a unique alphanumeric id.');
    const input = values.get(step.from ?? 'source');
    if (!input?.data) fail(`${step.id} must refer to an image-producing step.`);
    let result;
    if (imageOps.has(step.op)) { result = await imageStep(step, input); values.set(step.id, result); result = bitmapResult(result); }
    else if (analysisOps.has(step.op)) { result = step.op === 'ocr' ? await ocrStep(step, input) : analysisStep(step, input); values.set(step.id, { value: result }); }
    else fail(`unsupported operation ${step.op}.`);
    results.push({ id: step.id, op: step.op, result });
  }
  return { image: source, dimensions: [info.width, info.height], results };
}

export async function runRecipeFile(file) {
  const absolute = path.resolve(file);
  const spec = JSON.parse(await fs.readFile(absolute, 'utf8'));
  if (spec.image && !path.isAbsolute(spec.image)) spec.image = path.resolve(path.dirname(absolute), spec.image);
  return runRecipe(spec);
}
