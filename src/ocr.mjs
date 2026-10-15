import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveDependency } from './common.mjs';

const require = createRequire(import.meta.url);
const sharp = require(resolveDependency('sharp'));
const { createWorker } = require(resolveDependency('tesseract.js'));

export async function recognizeText(image, { box, minConfidence = 50, language = 'eng', pageSegMode = null } = {}) {
  const started = performance.now();
  const input = typeof image === 'string' ? path.resolve(image) : image;
  const buffer = box ? await sharp(input).extract({ left: box[0], top: box[1], width: box[2], height: box[3] }).png().toBuffer() : input;
  if (!/^[a-z_]{2,12}$/i.test(language)) throw new Error('OCR language must be a Tesseract language code.');
  let dataRoot;
  try { dataRoot = path.dirname(require.resolve(`@tesseract.js-data/${language}/package.json`)); }
  catch { throw new Error(`Local OCR data for ${language} is missing. Install @tesseract.js-data/${language} or use a vision adapter.`); }
  const best = path.join(dataRoot, '4.0.0_best_int');
  const langPath = await fs.access(best).then(() => best).catch(() => path.join(dataRoot, '4.0.0'));
  const worker = await createWorker(language, 1, { langPath, cacheMethod: 'none' });
  try {
    await worker.setParameters({ user_defined_dpi: '300', ...(pageSegMode ? { tessedit_pageseg_mode: String(pageSegMode) } : {}) });
    const { data } = await worker.recognize(buffer, {}, { text: true, blocks: true });
    const lines = [], words = [];
    for (const block of data.blocks ?? []) for (const paragraph of block.paragraphs ?? []) for (const line of paragraph.lines ?? []) {
      const text = line.text?.trim();
      if (!text || line.confidence < minConfidence) continue;
      const b = line.bbox;
      if (!b) continue;
      const bounds = [b.x0 + (box?.[0] ?? 0), b.y0 + (box?.[1] ?? 0), b.x1 - b.x0, b.y1 - b.y0];
      lines.push({ text, bounds, confidence: Math.round(line.confidence) / 100 });
      for (const word of line.words ?? []) {
        if (!word.text?.trim() || word.confidence < minConfidence || !word.bbox) continue;
        const w = word.bbox;
        words.push({ text: word.text.trim(), bounds: [w.x0 + (box?.[0] ?? 0), w.y0 + (box?.[1] ?? 0), w.x1 - w.x0, w.y1 - w.y0], confidence: Math.round(word.confidence) / 100 });
      }
    }
    return { text: data.text?.trim() ?? '', lines, words, elapsedMs: Math.round(performance.now() - started), engine: 'tesseract.js', language };
  } finally { await worker.terminate(); }
}

/** Read many small single-line crops with one worker (page mode 7: one text line). */
export async function readLines(buffers, { language = 'eng' } = {}) {
  if (!buffers.length) return [];
  const dataRoot = path.dirname(require.resolve(`@tesseract.js-data/${language}/package.json`));
  const best = path.join(dataRoot, '4.0.0_best_int');
  const langPath = await fs.access(best).then(() => best).catch(() => path.join(dataRoot, '4.0.0'));
  const worker = await createWorker(language, 1, { langPath, cacheMethod: 'none' });
  try {
    await worker.setParameters({ user_defined_dpi: '300', tessedit_pageseg_mode: '7' });
    const out = [];
    for (const buffer of buffers) {
      const { data } = await worker.recognize(buffer);
      out.push({ text: (data.text || '').replace(/\s+/g, ' ').trim(), confidence: (data.confidence || 0) / 100 });
    }
    return out;
  } finally { await worker.terminate(); }
}
