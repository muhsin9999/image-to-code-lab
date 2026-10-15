import fs from 'node:fs/promises';
import path from 'node:path';

const kinds = new Set(['container', 'text', 'control', 'media', 'icon', 'decoration', 'logo']);
const assetKinds = new Set(['image', 'video', 'model3d', 'audio', 'icon', 'logo', 'font', 'unknown']);
const routes = new Set(['provided', 'extract', 'generate', 'source', 'library', 'code', 'unresolved']);
const intersects = (a, b) => a && b && a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

function box(value, viewport, label) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length !== 4 || value.some(n => !Number.isFinite(n)) || value[0] < 0 || value[1] < 0 || value[2] <= 0 || value[3] <= 0 || value[0] + value[2] > viewport.width || value[1] + value[3] > viewport.height)
    throw new Error(`${label}.box must be [x,y,width,height] within ${viewport.width}x${viewport.height}, or null.`);
  return value;
}

function confidence(value) {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : 0.7;
}

export async function ingestCompactPlan({ planFile, screenshot, out, brief = '', viewport }) {
  const plan = JSON.parse(await fs.readFile(path.resolve(planFile), 'utf8'));
  if (!Array.isArray(plan.sections) || plan.sections.length === 0) throw new Error('Compact plan needs a nonempty sections array.');
  if (!viewport?.width || !viewport?.height) throw new Error('Screenshot viewport is required.');
  const regions = [], elements = [], assets = [], unknowns = [];
  let elementIndex = 0, assetIndex = 0;

  function addItems(items, parentId) {
    if (!Array.isArray(items)) throw new Error(`${parentId}.items must be an array.`);
    for (const item of items) {
      if (!item || !kinds.has(item.type)) throw new Error(`${parentId}: item type must be container, text, control, media, icon, decoration, or logo.`);
      const id = `element-${++elementIndex}`;
      const bounds = box(item.box, viewport, id);
      const kind = item.type === 'logo' ? (item.text ? 'text' : 'media') : item.type;
      if (['text', 'control'].includes(kind) && !item.text) throw new Error(`${id}: ${kind} needs visible text (use a descriptive label for an icon-only control).`);
      const element = { id, parentId, kind, role: item.role || item.type, bounds, confidence: confidence(item.confidence), evidence: 'observed' };
      if (item.text != null) element.text = String(item.text);
      if (item.style) element.style = item.style;
      if (item.notes) element.notes = item.notes;
      elements.push(element);
      if (['media', 'icon'].includes(kind) || item.type === 'logo') {
        const spec = item.asset || {};
        const assetKind = item.type === 'logo' ? 'logo' : item.type === 'icon' ? 'icon' : spec.kind || 'image';
        if (!assetKinds.has(assetKind)) throw new Error(`${id}: invalid asset kind ${assetKind}.`);
        if (!(item.type === 'logo' && item.text && !item.asset)) {
          const assetId = `asset-${++assetIndex}`;
          element.assetId = assetId;
          const description = spec.description || item.role || `${assetKind} in ${parentId}`;
          const asset = { id: assetId, elementId: id, kind: assetKind, confidence: confidence(spec.confidence ?? item.confidence), evidence: spec.evidence || 'Visible in the screenshot.', route: spec.route || (item.type === 'logo' && item.text ? 'code' : 'unresolved'), resolvedPath: spec.path || null, description };
          if (spec.scene) asset.scene = true;
          if (!routes.has(asset.route)) throw new Error(`${assetId}: invalid route ${asset.route}.`);
          if (asset.route === 'library') {
            if (asset.kind !== 'icon' || !spec.libraryName) throw new Error(`${assetId}: library route needs an icon libraryName.`);
            asset.libraryName = spec.libraryName;
          }
          if (['generate', 'source'].includes(asset.route)) asset.request = spec.request || { goal: description, constraints: ['No page text or controls in the asset.'], integration: 'Place inside the recorded element bounds.' };
          if (['image', 'video', 'model3d'].includes(asset.kind)) asset.temporal = spec.temporal || { type: 'unknown', evidence: 'A still screenshot does not establish motion.' };
          if (asset.kind === 'logo') asset.logo = spec.logo || { form: item.text ? 'wordmark' : 'unknown', visibleText: item.text || null, background: 'unknown' };
          assets.push(asset);
        }
      }
      if (item.items) addItems(item.items, id);
    }
  }

  for (const [index, section] of plan.sections.entries()) {
    if (!section || !section.role) throw new Error(`Section ${index + 1} needs a role.`);
    const id = `region-${index + 1}`;
    const sectionBox = box(section.box, viewport, id);
    regions.push({ id, role: section.role, bounds: sectionBox, parentId: null, confidence: confidence(section.confidence), ...(section.style ? { style: section.style } : {}) });
    const items = section.items || [];
    const largePhotoTiles = items.filter(item => item?.type === 'media' && (item.asset?.kind || 'image') === 'image' &&
      /photo|background|wall|shelf|scene/i.test(item.role || '') && item.box && sectionBox &&
      item.box[2] * item.box[3] >= sectionBox[2] * sectionBox[3] * 0.02);
    const hasLiveUi = items.some(item => ['text', 'control'].includes(item?.type));
    const inferredScene = !section.scene && hasLiveUi && largePhotoTiles.length >= 2 &&
      /hero|banner|cover|masthead|background/i.test(section.role);
    const scene = section.scene || (inferredScene ? { kind: 'image', route: 'unresolved',
      description: largePhotoTiles.map(item => item.asset?.description || item.role).join('; ') } : null);
    if (scene) {
      if (!sectionBox) throw new Error(`${id}: a continuous scene needs a section box.`);
      addItems([{ type: 'media', role: 'continuous background scene', box: sectionBox,
        asset: { ...scene, scene: true, route: scene.route || 'unresolved' } }], id);
      if (inferredScene) unknowns.push({ question: `Several photo tiles in ${section.role} were combined into one pending background scene. Do not reconstruct a scene by slicing around text.`,
        relatedIds: [id], impact: 'Use a supplied original or generate the scene after the first render.' });
    }
    addItems(scene ? items.filter(item => !largePhotoTiles.includes(item) && !(item.type === 'media' && item.asset?.scene)) : items, id);
  }

  for (const asset of assets) {
    if (asset.route !== 'extract') continue;
    const element = elements.find(item => item.id === asset.elementId);
    const overlap = elements.some(item => item.id !== element.id && ['text', 'control', 'icon'].includes(item.kind) && intersects(element.bounds, item.bounds));
    if (overlap) {
      asset.route = 'unresolved';
      unknowns.push({ question: `Asset ${asset.id} was marked extract, but its crop contains live UI. Supply or generate clean media.`, relatedIds: [asset.id, element.id], impact: 'Media can use a placeholder for the first render.' });
    }
  }
  if (Array.isArray(plan.unknowns)) for (const question of plan.unknowns) if (typeof question === 'string' && question.trim()) unknowns.push({ question: question.trim(), relatedIds: [], impact: 'Check after the first render.' });
  const inventory = { schemaVersion: '1.0', source: { screenshot: path.relative(path.resolve(out), path.resolve(screenshot)).replaceAll('\\', '/'), viewport, brief }, regions, elements, assets, unknowns };
  await fs.mkdir(path.resolve(out), { recursive: true });
  const file = path.join(path.resolve(out), 'page-inventory.json');
  await fs.writeFile(file, JSON.stringify(inventory, null, 2) + '\n');
  return { file, regions: regions.length, elements: elements.length, assets: assets.length, unknowns: unknowns.length };
}
