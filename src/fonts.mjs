import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { boxOf, requireDependency, resolveDependency } from './common.mjs';

const require = createRequire(import.meta.url);
const sharp = require(resolveDependency('sharp'));
const { chromium } = requireDependency('playwright');
const DEFAULT_FAMILIES = ['inter', 'space-grotesk', 'lora', 'libre-baskerville', 'playfair-display', 'cormorant-garamond', 'bodoni-moda'];

async function defaultFonts() {
  const result = [];
  for (const family of DEFAULT_FAMILIES) {
    let root;
    try { root = path.dirname(require.resolve(`@fontsource/${family}/package.json`)); }
    catch { continue; }
    const files = await fs.readdir(path.join(root, 'files'));
    const file = files.find(name => name.endsWith('-latin-400-normal.woff2'));
    if (file) result.push({ name: family.replaceAll('-', ' '), path: path.join(root, 'files', file) });
  }
  return result;
}

async function customFonts(directory) {
  if (!directory) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries.filter(entry => entry.isFile() && /\.(woff2?|ttf|otf)$/i.test(entry.name))
    .map(entry => ({ name: path.basename(entry.name, path.extname(entry.name)).replaceAll('_', ' '), path: path.resolve(directory, entry.name) }));
}

function tightMask(raw, width, height, dark = true) {
  const ink = new Uint8Array(width * height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = raw[y * width + x];
    const on = dark ? v < 150 : v > 180;
    if (!on) continue;
    ink[y * width + x] = 1;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const cut = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cut[y * w + x] = ink[(minY + y) * width + minX + x];
  return { data: cut, width: w, height: h };
}

async function maskFromPng(buffer, crop, dark = true) {
  let pipeline = sharp(buffer).removeAlpha().greyscale();
  if (crop) pipeline = pipeline.extract({ left: crop[0], top: crop[1], width: crop[2], height: crop[3] });
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return tightMask(data, info.width, info.height, dark);
}

function similarity(a, b) {
  const canvasWidth = Math.max(a.width, b.width) + 6;
  const canvasHeight = Math.max(a.height, b.height) + 6;
  let best = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    let intersection = 0, union = 0;
    for (let y = 0; y < canvasHeight; y++) for (let x = 0; x < canvasWidth; x++) {
      const ax = x - 3, ay = y - 3, bx = ax - dx, by = ay - dy;
      const av = ax >= 0 && ay >= 0 && ax < a.width && ay < a.height ? a.data[ay * a.width + ax] : 0;
      const bv = bx >= 0 && by >= 0 && bx < b.width && by < b.height ? b.data[by * b.width + bx] : 0;
      if (av || bv) union++;
      if (av && bv) intersection++;
    }
    best = Math.max(best, union ? intersection / union : 0);
  }
  return best;
}

export async function rankFonts({ text, targetWidth, targetHeight, size = 64, screenshot, crop, fontDir, top = 5 }) {
  if (!text || !Number.isFinite(Number(targetWidth)) || Number(targetWidth) <= 0) throw new Error('Use --text and a positive --target-width.');
  const start = performance.now();
  const fonts = [...await defaultFonts(), ...await customFonts(fontDir)];
  if (!fonts.length) throw new Error('No cached fonts found. Run npm install or provide --font-dir.');
  const targetCrop = crop ? boxOf(crop, 'crop') : null;
  if (targetCrop && !screenshot) throw new Error('--crop requires --screenshot.');
  const targetMask = targetCrop ? await maskFromPng(await fs.readFile(screenshot), targetCrop) : null;
  const desiredHeight = Number(targetHeight) || targetMask?.height || null;
  const requestedBrowser = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const executablePath = await fs.access(requestedBrowser).then(() => requestedBrowser).catch(() => undefined);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const page = await browser.newPage();
    const faceData = await Promise.all(fonts.map(async (font, index) => ({
      name: font.name,
      family: `i2c_${index}`,
      source: `data:font/${path.extname(font.path).slice(1)};base64,${(await fs.readFile(font.path)).toString('base64')}`,
    })));
    const metrics = await page.evaluate(async ({ faces, text, size, desiredHeight }) => {
      const ctx = document.createElement('canvas').getContext('2d');
      const results = [];
      for (const face of faces) {
        try {
          const font = new FontFace(face.family, `url(${face.source})`);
          await font.load();
          document.fonts.add(font);
          ctx.font = `${size}px "${face.family}"`;
          const m = ctx.measureText(text);
          const inkHeight = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
          const fittedSize = desiredHeight && inkHeight ? size * desiredHeight / inkHeight : size;
          ctx.font = `${fittedSize}px "${face.family}"`;
          const fitted = ctx.measureText(text);
          results.push({ name: face.name, family: face.family, fontSize: fittedSize,
            width: fitted.width, inkHeight: fitted.actualBoundingBoxAscent + fitted.actualBoundingBoxDescent });
        } catch { /* a broken optional font should not stop ranking */ }
      }
      return results;
    }, { faces: faceData, text, size: Number(size), desiredHeight });
    const ranked = metrics.map(row => ({ ...row,
      widthError: Math.abs(row.width - targetWidth) / targetWidth,
      heightError: desiredHeight ? Math.abs(row.inkHeight - desiredHeight) / desiredHeight : null,
    })).sort((a, b) => a.widthError - b.widthError);
    const considered = targetMask ? ranked.slice(0, Math.max(1, Number(top))) : ranked;
    if (targetMask) {
      for (const row of considered) {
        const pngBase64 = await page.evaluate(({ family, text, size }) => {
          const canvas = document.createElement('canvas');
          canvas.width = 1800; canvas.height = 240;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = 'black'; ctx.font = `${size}px "${family}"`; ctx.textBaseline = 'alphabetic';
          ctx.fillText(text, 20, 160);
          return canvas.toDataURL('image/png').split(',')[1];
        }, { family: row.family, text, size: row.fontSize });
        const mask = await maskFromPng(Buffer.from(pngBase64, 'base64'));
        row.shapeSimilarity = mask ? similarity(targetMask, mask) : 0;
      }
    }
    for (const row of considered) row.score = Math.round(1000 * (targetMask ? 0.7 * row.widthError + 0.3 * (1 - row.shapeSimilarity) : row.widthError)) / 1000;
    considered.sort((a, b) => a.score - b.score);
    return { text, targetWidth: Number(targetWidth), targetHeight: desiredHeight, candidates: considered.slice(0, Number(top)).map(({ family, ...row }) => row), testedFonts: fonts.length, elapsedMs: Math.round(performance.now() - start),
      note: 'A font match is a shortlist, not proof of the original family. Check weight, letter spacing, and browser wrapping.' };
  } finally { await browser.close(); }
}
