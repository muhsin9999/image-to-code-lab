import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { inspectScreenshot } from './inspect.mjs';
import { runRecipe } from './ops.mjs';
import { recognizeText } from './ocr.mjs';
import { resolveDependency } from './common.mjs';
import { splitOcrLines } from './design-hints.mjs';

const require = createRequire(import.meta.url);
const sharp = require(resolveDependency('sharp'));

function boxWithin(bounds, width, height) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || bounds.some(n => !Number.isFinite(n))) return null;
  const [x, y, w, h] = bounds.map(Math.round);
  if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height) return null;
  return [x, y, w, h];
}

async function detectorOutput({ screenshot, detectorFile, detectorCommand }) {
  if (detectorFile && detectorCommand) throw new Error('Use either detectorFile or detectorCommand.');
  if (detectorFile) return JSON.parse(await fs.readFile(path.resolve(detectorFile), 'utf8'));
  if (!detectorCommand) return null;
  if (!Array.isArray(detectorCommand) || !detectorCommand.length) throw new Error('detectorCommand must be a command array.');
  const child = spawn(detectorCommand[0], detectorCommand.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', data => stdout.push(data));
  child.stderr.on('data', data => stderr.push(data));
  child.stdin.end(JSON.stringify({ screenshot: path.resolve(screenshot) }) + '\n');
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (code) throw new Error(`UI detector failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`);
  return JSON.parse(Buffer.concat(stdout).toString('utf8'));
}

/** Return observations, not a claimed design tree. OCR and UI parsing run concurrently. */
export async function analyzeScreenshot({ screenshot, language = 'eng', detectorFile, detectorCommand, ocrMaxDimension = null }) {
  const started = performance.now();
  const source = path.resolve(screenshot);
  const meta = await sharp(source).metadata();
  if (!meta.width || !meta.height) throw new Error('Cannot read screenshot dimensions.');
  const scale = Math.min(1, 768 / Math.max(meta.width, meta.height));
  const sampleWidth = Math.max(1, Math.round(meta.width * scale));
  const sampleHeight = Math.max(1, Math.round(meta.height * scale));
  const ocrScale = ocrMaxDimension && Math.max(meta.width, meta.height) > ocrMaxDimension
    ? ocrMaxDimension / Math.max(meta.width, meta.height) : 1;
  const ocrTask = language === 'none' ? Promise.resolve({ text: '', lines: [], words: [], elapsedMs: 0, engine: 'disabled', language: null }) :
    (async () => {
      const input = ocrScale === 1 ? source : await sharp(source).resize({ width: Math.round(meta.width * ocrScale),
        height: Math.round(meta.height * ocrScale), fit: 'fill' }).png().toBuffer();
      const result = await recognizeText(input, { language });
      if (ocrScale === 1) return result;
      const mapBox = bounds => bounds.map((value, index) => Math.round(value / ocrScale));
      return { ...result, lines: result.lines.map(item => ({ ...item, bounds: mapBox(item.bounds) })),
        words: result.words.map(item => ({ ...item, bounds: mapBox(item.bounds) })) };
    })();
  const recipe = { image: source, steps: [
    { id: 'palette', op: 'palette', top: 8 },
    { id: 'horizontal-edges', op: 'edges', axis: 'y', minDelta: 10, top: 20 },
    { id: 'vertical-edges', op: 'edges', axis: 'x', minDelta: 10, top: 20 },
    { id: 'visual-grid', op: 'grid', columns: 12, rows: 8 },
    { id: 'small', op: 'resize', width: sampleWidth, height: sampleHeight },
    { id: 'dark', from: 'small', op: 'threshold', mode: 'dark', value: 110 },
    { id: 'dark-components', from: 'dark', op: 'components', minArea: 8, top: 160 },
    { id: 'light', from: 'small', op: 'threshold', mode: 'light', value: 220 },
    { id: 'light-components', from: 'light', op: 'components', minArea: 12, top: 100 },
  ] };
  const [inspection, recipeResult, ocr, detected] = await Promise.all([
    inspectScreenshot(source),
    runRecipe(recipe),
    ocrTask,
    detectorOutput({ screenshot: source, detectorFile, detectorCommand }),
  ]);
  const ops = Object.fromEntries(recipeResult.results.map(item => [item.id, item.result]));
  const detectorElements = Array.isArray(detected) ? detected : detected?.elements ?? [];
  if (!Array.isArray(detectorElements)) throw new Error('UI detector must return an array or an object with an elements array.');
  const external = detectorElements.map((item, index) => ({
    id: item.id || `detector-${index + 1}`,
    bounds: boxWithin(item.bounds || item.box, meta.width, meta.height),
    kind: item.kind || item.type || 'unknown',
    label: item.label || item.description || '',
    confidence: typeof item.confidence === 'number' ? item.confidence : null,
    source: 'external-detector',
  })).filter(item => item.bounds);
  const components = [...(ops['dark-components'] || []), ...(ops['light-components'] || [])]
    .map((item, index) => ({ id: `component-${index + 1}`, bounds: boxWithin(item.sourceBounds, meta.width, meta.height),
      source: 'threshold-component', confidence: null }))
    .filter(item => item.bounds && item.bounds[2] >= 8 && item.bounds[3] >= 5 && item.bounds[2] * item.bounds[3] < meta.width * meta.height * 0.4)
    .slice(0, 180);
  return {
    screenshot: source, viewport: { width: meta.width, height: meta.height }, inspection,
    palette: ops.palette, horizontalEdges: ops['horizontal-edges'], verticalEdges: ops['vertical-edges'], visualGrid: ops['visual-grid'],
    ocr: { ...ocr, spatialLines: splitOcrLines(ocr.lines, ocr.words) }, detections: external, componentCandidates: components,
    detector: detected ? 'external' : 'basic-components', ocrScale,
    note: 'OCR and component boxes are observations. They do not establish semantic roles, hierarchy, exact fonts, or behavior.',
    elapsedMs: Math.round(performance.now() - started),
  };
}
