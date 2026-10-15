import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { resolveDependency } from '../src/common.mjs';

const require = createRequire(import.meta.url);
const sharp = require(resolveDependency('sharp'));

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/validate-inventory.mjs <page-inventory.json>');
  process.exit(2);
}

const errors = [];
const fail = (message) => errors.push(message);
const data = JSON.parse(await readFile(file, 'utf8'));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const confidence = (value, label) => {
  if (typeof value !== 'number' || value < 0 || value > 1) fail(`${label}: confidence must be 0–1`);
};
const bounds = (value, label) => {
  if (value === null) return;
  if (!Array.isArray(value) || value.length !== 4 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n)) || value[2] <= 0 || value[3] <= 0) fail(`${label}: bounds must be null or [x,y,width,height]`);
  else if (Number.isInteger(actualWidth) && (value[0] < 0 || value[1] < 0 || value[0] + value[2] > actualWidth || value[1] + value[3] > actualHeight))
    fail(`${label}: bounds extend outside the ${actualWidth}x${actualHeight} screenshot`);
};
let actualWidth, actualHeight;

if (data.schemaVersion !== '1.0') fail('schemaVersion must be 1.0');
if (!object(data.source) || !object(data.source.viewport) || !Number.isInteger(data.source.viewport.width) || !Number.isInteger(data.source.viewport.height) || data.source.viewport.width <= 0 || data.source.viewport.height <= 0) fail('source.viewport needs positive integer width and height');
if (typeof data.source?.screenshot !== 'string') fail('source.screenshot is required');
else {
  try {
    const screenshot = resolve(dirname(file), data.source.screenshot);
    await access(screenshot);
    const meta = await sharp(screenshot).metadata();
    actualWidth = meta.width; actualHeight = meta.height;
    if (data.source.viewport?.width !== actualWidth || data.source.viewport?.height !== actualHeight)
      fail(`source.viewport must match screenshot dimensions ${actualWidth}x${actualHeight}`);
  }
  catch { fail(`screenshot not found relative to inventory: ${data.source.screenshot}`); }
}
for (const key of ['regions', 'elements', 'assets', 'unknowns']) if (!Array.isArray(data[key])) fail(`${key} must be an array`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

const regions = new Map();
const elements = new Map();
const assets = new Map();
for (const region of data.regions) {
  if (!object(region) || !region.id) { fail('every region needs an ID'); continue; }
  if (regions.has(region.id)) fail(`duplicate region ID: ${region.id}`);
  regions.set(region.id, region);
  confidence(region.confidence, region.id);
  bounds(region.bounds, region.id);
}
for (const element of data.elements) {
  if (!object(element) || !element.id) { fail('every element needs an ID'); continue; }
  if (elements.has(element.id) || regions.has(element.id)) fail(`duplicate element ID: ${element.id}`);
  elements.set(element.id, element);
  confidence(element.confidence, element.id);
  bounds(element.bounds, element.id);
  if (!['container', 'text', 'control', 'media', 'icon', 'decoration'].includes(element.kind)) fail(`${element.id}: invalid kind`);
  if (!['observed', 'inferred'].includes(element.evidence)) fail(`${element.id}: evidence must be observed or inferred`);
}
for (const asset of data.assets) {
  if (!object(asset) || !asset.id) { fail('every asset needs an ID'); continue; }
  if (assets.has(asset.id)) fail(`duplicate asset ID: ${asset.id}`);
  assets.set(asset.id, asset);
  confidence(asset.confidence, asset.id);
  if (!['image', 'video', 'model3d', 'audio', 'icon', 'logo', 'font', 'unknown'].includes(asset.kind)) fail(`${asset.id}: invalid asset kind`);
  if (asset.logo !== undefined) {
    if (asset.kind !== 'logo' || !object(asset.logo)) fail(`${asset.id}: logo metadata requires a logo asset`);
    else {
      if (asset.logo.form !== undefined && !['wordmark', 'symbol', 'combination', 'unknown'].includes(asset.logo.form)) fail(`${asset.id}: invalid logo form`);
      if (asset.logo.visibleText !== undefined && asset.logo.visibleText !== null && typeof asset.logo.visibleText !== 'string') fail(`${asset.id}: logo.visibleText must be text or null`);
      if (asset.logo.variantsNeeded !== undefined && (!Array.isArray(asset.logo.variantsNeeded) || asset.logo.variantsNeeded.some(value => typeof value !== 'string'))) fail(`${asset.id}: logo.variantsNeeded must be text values`);
      if (asset.logo.background !== undefined && !['transparent', 'opaque', 'unknown'].includes(asset.logo.background)) fail(`${asset.id}: invalid logo background`);
    }
  }
  if (!['provided', 'extract', 'generate', 'source', 'library', 'code', 'unresolved'].includes(asset.route)) fail(`${asset.id}: invalid acquisition route`);
  if (asset.route === 'library' && asset.kind !== 'icon') fail(`${asset.id}: library route only supports generic icons`);
  if (asset.route === 'library' && !asset.libraryName) fail(`${asset.id}: libraryName is required`);
  if (asset.temporal && (!object(asset.temporal) || !['still', 'video', 'animation', 'model3d', 'unknown'].includes(asset.temporal.type) || typeof asset.temporal.evidence !== 'string')) fail(`${asset.id}: invalid temporal evidence`);
  if (['generate', 'source'].includes(asset.route)) {
    const request = asset.request;
    for (const key of ['goal', 'constraints', 'integration']) if (!object(request) || !(key in request)) fail(`${asset.id}: ${key} missing from asset request`);
    if (object(request) && !Array.isArray(request.constraints)) fail(`${asset.id}: request.constraints must be an array`);
  }
}
for (const region of regions.values()) if (region.parentId !== null && !regions.has(region.parentId)) fail(`${region.id}: unknown parent region ${region.parentId}`);
for (const element of elements.values()) {
  if (!regions.has(element.parentId) && !elements.has(element.parentId)) fail(`${element.id}: unknown parent ${element.parentId}`);
  if (element.assetId && !assets.has(element.assetId)) fail(`${element.id}: unknown asset ${element.assetId}`);
  if (element.kind === 'media' && !element.assetId) fail(`${element.id}: media element needs assetId`);
}
for (const asset of assets.values()) {
  if (!elements.has(asset.elementId)) fail(`${asset.id}: unknown element ${asset.elementId}`);
  else if (asset.kind !== 'font' && elements.get(asset.elementId).assetId !== asset.id) fail(`${asset.id}: element must refer back to asset`);
}
for (const element of elements.values()) {
  const seen = new Set([element.id]);
  let parent = element.parentId;
  while (elements.has(parent)) {
    if (seen.has(parent)) { fail(`${element.id}: parent cycle`); break; }
    seen.add(parent);
    parent = elements.get(parent).parentId;
  }
}
for (const unknown of data.unknowns) {
  if (!object(unknown) || !unknown.question || !Array.isArray(unknown.relatedIds)) { fail('each unknown needs a question and relatedIds'); continue; }
  for (const id of unknown.relatedIds) if (!regions.has(id) && !elements.has(id) && !assets.has(id)) fail(`unknown question references missing ID: ${id}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Valid inventory: ${data.regions.length} regions, ${data.elements.length} elements, ${data.assets.length} assets, ${data.unknowns.length} unknowns`);
