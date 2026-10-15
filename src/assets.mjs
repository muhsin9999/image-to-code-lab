import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { boxOf, resolveDependency } from './common.mjs';

const require = createRequire(import.meta.url);
const sharp = require(resolveDependency('sharp'));

export async function planAssets(inventoryPath) {
  const inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8'));
  const elements = new Map((inventory.elements || []).map(element => [element.id, element]));
  return Promise.all((inventory.assets || []).map(async asset => {
    const element = elements.get(asset.elementId);
    const request = asset.request || null;
    const absolutePath = asset.resolvedPath ? path.resolve(path.dirname(path.resolve(inventoryPath)), asset.resolvedPath) : null;
    const fileReady = absolutePath ? await fs.access(absolutePath).then(() => true).catch(() => false) : asset.route === 'code';
    const overlappingUi = element?.bounds ? (inventory.elements || []).filter(item =>
      item.id !== asset.elementId && ['text', 'control', 'icon'].includes(item.kind) && item.bounds && intersects(element.bounds, item.bounds)
    ).map(item => item.id) : [];
    const cleanCrop = Boolean(element?.bounds) && overlappingUi.length === 0;
    const ready = fileReady && !(asset.route === 'extract' && !cleanCrop);
    return {
      id: asset.id,
      kind: asset.kind,
      elementId: asset.elementId,
      bounds: element?.bounds ?? null,
      route: asset.route,
      resolvedPath: asset.resolvedPath,
      absolutePath,
      ready,
      cleanCrop,
      scene: asset.scene === true,
      overlappingUi,
      temporal: ['image', 'video', 'model3d'].includes(asset.kind) ? asset.temporal ?? { type: 'unknown', evidence: 'A still image alone cannot establish motion.' } : undefined,
      request,
      logo: asset.kind === 'logo' ? asset.logo ?? null : undefined,
      nextAction: ready ? 'ready' : asset.route === 'extract' && !cleanCrop ?
        asset.scene ? 'continuous background scene contains live UI; use an original or generated asset' :
        `crop overlaps live UI (${overlappingUi.join(', ')}); use a supplied or generated asset` :
        asset.resolvedPath ? `file missing: ${absolutePath}` : ({
        provided: 'copy supplied original asset',
        extract: cleanCrop ? 'extract original pixels' : 'crop overlaps live UI; use a generated or supplied asset',
        generate: 'send request to an asset-generation adapter',
        library: 'search the icon library, choose a name, then resolve it',
        source: 'find a licensed original or close source asset',
        code: asset.kind === 'logo' ? 'render a live text wordmark or use a supplied brand mark' : 'render with CSS or select a library icon',
        unresolved: 'classify from more evidence',
      }[asset.route] || 'classify'),
      logoGuidance: asset.kind === 'logo'
        ? 'Prefer the supplied/original mark. Record wordmark, symbol, variants, and transparency. Do not guess a real brand mark.'
        : undefined,
    };
  }));
}

function intersects(a, b) {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

function parseColor(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(value || '');
  if (!match) throw new Error('--key-color must be a six-digit hex color.');
  return [0, 2, 4].map(i => parseInt(match[1].slice(i, i + 2), 16));
}

export async function extractAsset({ screenshot, out, box, inventoryPath, assetId, mask, keyColor, tolerance = 28 }) {
  if (path.extname(out).toLowerCase() !== '.png') throw new Error('assets-extract writes PNG data; --out must end in .png.');
  const image = path.resolve(screenshot);
  const meta = await sharp(image).metadata();
  if (!meta.width || !meta.height) throw new Error('Cannot read screenshot dimensions.');
  let inventory;
  let asset;
  if (inventoryPath) {
    inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8'));
    asset = assetId ? (inventory.assets || []).find(item => item.id === assetId) : undefined;
    if (assetId && !asset) throw new Error(`Unknown asset ID: ${assetId}`);
  }
  const element = asset && inventory.elements.find(item => item.id === asset.elementId);
  const rect = boxOf(box || element?.bounds, 'asset box');
  if (rect[0] + rect[2] > meta.width || rect[1] + rect[3] > meta.height) throw new Error('Asset box extends outside the screenshot.');

  const uiOverlaps = (inventory?.elements || []).filter(item =>
    item.id !== asset?.elementId && ['text', 'control', 'icon'].includes(item.kind) && item.bounds && intersects(rect, item.bounds)
  ).map(item => item.id);
  if (uiOverlaps.length) {
    throw new Error(`Crop intersects live UI (${uiOverlaps.join(', ')}). Use a supplied original or generate an asset; do not paint away UI.`);
  }

  const region = { left: rect[0], top: rect[1], width: rect[2], height: rect[3] };
  let { data, info } = await sharp(image).extract(region).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (mask) {
    const maskMeta = await sharp(mask).metadata();
    let pipeline = sharp(mask);
    if (maskMeta.width === meta.width && maskMeta.height === meta.height) pipeline = pipeline.extract(region);
    else if (maskMeta.width !== rect[2] || maskMeta.height !== rect[3]) throw new Error('Mask must match screenshot or asset crop dimensions.');
    const alpha = await pipeline.removeAlpha().greyscale().raw().toBuffer();
    for (let i = 0; i < rect[2] * rect[3]; i++) data[i * 4 + 3] = Math.round(data[i * 4 + 3] * alpha[i] / 255);
  }
  if (keyColor) {
    const key = parseColor(keyColor);
    const limit = Number(tolerance);
    if (!Number.isFinite(limit) || limit < 0 || limit > 255) throw new Error('--tolerance must be 0–255.');
    for (let i = 0; i < rect[2] * rect[3]; i++) {
      const offset = i * 4;
      const distance = Math.max(...key.map((channel, c) => Math.abs(channel - data[offset + c])));
      if (distance <= limit) data[offset + 3] = 0;
    }
  }
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(out);
  return { output: path.resolve(out), source: image, box: rect, kind: asset?.kind || 'unknown', method: mask ? 'masked crop' : keyColor ? 'color-key crop' : 'clean crop', uiOverlaps };
}

async function externalGeneration(command, payload) {
  if (!Array.isArray(command)) throw new Error('--command is required for the command generator.');
  const [program, ...args] = command;
  if (!program) throw new Error('Generator command is empty.');
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let output = '', error = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error += data; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code) return reject(new Error(`Generator failed (${code}): ${error.slice(0, 1000)}`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Generator must return JSON with filePath or base64.')); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function openRouterGeneration(payload, model, endpoint) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is required for the OpenRouter generator.');
  if (!model) throw new Error('--model is required for the OpenRouter generator. Choose an image model that supports input references.');
  const reference = await fs.readFile(payload.referenceCrop);
  const response = await fetch(endpoint || 'https://openrouter.ai/api/v1/images', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: payload.prompt, n: 1, output_format: 'png',
      input_references: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${reference.toString('base64')}` } }] }),
  });
  if (!response.ok) throw new Error(`OpenRouter image request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const result = await response.json();
  if (!result.data?.[0]?.b64_json) throw new Error('OpenRouter returned no image bytes.');
  return { base64: result.data[0].b64_json, mediaType: result.data[0].media_type || 'image/png', usage: result.usage ?? null };
}

export async function resolveAsset({ inventoryPath, assetId, out, provider = 'openrouter', model, endpoint, generatorCommand, updateInventory = true }) {
  const file = path.resolve(inventoryPath);
  const inventory = JSON.parse(await fs.readFile(file, 'utf8'));
  const asset = inventory.assets?.find(item => item.id === assetId);
  if (!asset) throw new Error(`Unknown asset ID: ${assetId}`);
  const element = inventory.elements?.find(item => item.id === asset.elementId);
  if (!element?.bounds) throw new Error(`${assetId} has no visible bounds.`);
  const screenshot = path.resolve(path.dirname(file), inventory.source.screenshot);
  const output = path.resolve(out);
  const plan = (await planAssets(file)).find(item => item.id === assetId);
  if (asset.resolvedPath && plan.ready && asset.route !== 'generate') return { output: plan.absolutePath, route: asset.route, cached: true };
  if (asset.route === 'library') {
    if (asset.kind !== 'icon') throw new Error('The library route is for generic icons, not logos or photos.');
    if (!asset.libraryName) throw new Error(`${assetId} needs libraryName. Run icons search first.`);
    const { useIcon } = await import('./icons.mjs');
    const result = await useIcon(asset.libraryName, output);
    asset.resolvedPath = path.relative(path.dirname(file), output);
    if (updateInventory) await fs.writeFile(file, JSON.stringify(inventory, null, 2) + '\n');
    return { ...result, route: 'library', cached: false };
  }
  if (asset.route === 'extract') {
    if (!plan.cleanCrop) throw new Error(`${assetId} overlaps live UI (${plan.overlappingUi.join(', ')}). Change its route to generate or use a supplied original.`);
    const result = await extractAsset({ screenshot, out: output, inventoryPath: file, assetId });
    asset.resolvedPath = path.relative(path.dirname(file), output);
    if (updateInventory) await fs.writeFile(file, JSON.stringify(inventory, null, 2) + '\n');
    return { ...result, route: 'extract', cached: false };
  }
  if (asset.route !== 'generate') throw new Error(`${assetId} uses ${asset.route}; resolve it with its stated route.`);
  if (!asset.request?.goal) throw new Error(`${assetId} needs a generation request in the inventory.`);
  const crop = await sharp(screenshot).extract({ left: Math.round(element.bounds[0]), top: Math.round(element.bounds[1]),
    width: Math.round(element.bounds[2]), height: Math.round(element.bounds[3]) }).png().toBuffer();
  const fingerprint = crypto.createHash('sha256').update(crop).update(JSON.stringify({ request: asset.request, provider, model, endpoint, generatorCommand })).digest('hex');
  const cachePath = `${output}.generation.json`;
  const prior = await fs.readFile(cachePath, 'utf8').then(JSON.parse).catch(() => null);
  if (prior?.fingerprint === fingerprint && await fs.access(output).then(() => true).catch(() => false)) {
    asset.resolvedPath = path.relative(path.dirname(file), output);
    if (updateInventory) await fs.writeFile(file, JSON.stringify(inventory, null, 2) + '\n');
    return { output, route: 'generate', cached: true, provider };
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  const referenceCrop = `${output}.reference.png`;
  await fs.writeFile(referenceCrop, crop);
  const prompt = `${asset.request.goal}. ${asset.description}. ${asset.request.constraints?.join('. ') || ''}. Recreate only the visual asset. Remove overlaid website text, buttons, icons, navigation, and logos. Do not add readable text. Preserve composition, lighting, colors, and subject. The asset will be placed in a ${element.bounds[2]}x${element.bounds[3]} CSS box.`;
  const payload = { assetId, prompt, referenceCrop, width: Math.round(element.bounds[2]), height: Math.round(element.bounds[3]), request: asset.request };
  const generated = provider === 'command' ? await externalGeneration(generatorCommand, payload) :
    provider === 'openrouter' ? await openRouterGeneration(payload, model, endpoint) : null;
  if (!generated) throw new Error(`Unknown generator provider: ${provider}`);
  const bytes = generated.base64 ? Buffer.from(generated.base64, 'base64') : generated.filePath ? await fs.readFile(generated.filePath) : null;
  if (!bytes) throw new Error('Generator returned no filePath or base64.');
  await sharp(bytes).png().toFile(output);
  await fs.writeFile(cachePath, JSON.stringify({ fingerprint, provider, model: model ?? null, generatedAt: new Date().toISOString(), usage: generated.usage ?? null }, null, 2) + '\n');
  asset.resolvedPath = path.relative(path.dirname(file), output);
  if (updateInventory) await fs.writeFile(file, JSON.stringify(inventory, null, 2) + '\n');
  return { output, route: 'generate', cached: false, provider, referenceCrop, usage: generated.usage ?? null };
}

export async function resolveAssetsBatch({ inventoryPath, outDir, provider = 'openrouter', model, endpoint, generatorCommand, concurrency = 3 }) {
  const file = path.resolve(inventoryPath);
  const inventory = JSON.parse(await fs.readFile(file, 'utf8'));
  const planned = await planAssets(file);
  const queue = planned.filter(asset => !asset.ready && ['extract', 'library', 'generate'].includes(asset.route));
  await fs.mkdir(path.resolve(outDir), { recursive: true });
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      const ext = item.route === 'library' ? '.svg' : '.png';
      try {
        const result = await resolveAsset({ inventoryPath: file, assetId: item.id, out: path.join(path.resolve(outDir), item.id + ext),
          provider, model, endpoint, generatorCommand, updateInventory: false });
        results.push({ id: item.id, status: 'ready', ...result });
      } catch (error) { results.push({ id: item.id, status: 'failed', error: error.message }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, worker));
  const current = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const result of results) if (result.status === 'ready') {
    const asset = current.assets.find(item => item.id === result.id);
    if (asset) asset.resolvedPath = path.relative(path.dirname(file), result.output);
  }
  const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(current, null, 2) + '\n');
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
  return { attempted: queue.length, ready: results.filter(item => item.status === 'ready').length, results };
}
