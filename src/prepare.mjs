import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { analyzeScreenshot } from './analyze.mjs';
import { catalogAssets, enrichInventoryColors, makeAssetContactSheet } from './design-hints.mjs';
import { auditInventory } from './inventory-audit.mjs';

function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(item => item.type === 'text').map(item => item.text).join('');
  throw new Error('Vision model returned no text.');
}

async function openRouterInventory({ screenshot, brief, evidence, model, endpoint, assetCatalog, contactSheet }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is required when --model is used.');
  const image = await fs.readFile(screenshot);
  const sheet = contactSheet ? await fs.readFile(contactSheet) : null;
  const prompt = `Reconcile this screenshot and measured observations into one JSON page inventory. Preserve exact visible text when legible. Include every visible section, control, logo, icon, and media slot. Use [x,y,width,height] bounds in the ${evidence.inspection.width}x${evidence.inspection.height} screenshot. Correct false or missing detector boxes. Group related elements by parentId. Record uncertainty instead of inventing interaction, motion, video, or 3D behavior. For visible text, estimate fontFamily, fontSize, fontWeight, lineHeight, color and line wrapping in element.style; for flat regions and controls, record background, border and borderRadius. Prefer supplied original assets when visually confirmed; their paths are relative to the work directory. Never treat a candidate filename as proof of a match. A brand wordmark can be live text. Keep images separate from live controls. Use stable IDs and parent IDs. Return only JSON with keys schemaVersion ("1.0"), source {screenshot,viewport:{width,height},brief}, regions, elements, assets, unknowns. Each region needs id,role,bounds,parentId,confidence. Each element needs id,parentId,kind,role,bounds,confidence,evidence; text elements need text, media/icon elements can use assetId. Each asset needs id,elementId,kind,confidence,evidence,route,resolvedPath,description; generated/source assets need request {goal,constraints,integration}. Each unknown needs question,relatedIds,impact. Kinds: image,video,model3d,audio,icon,logo,font,unknown. Routes: provided,extract,generate,source,code,unresolved. Brief: ${brief}\nSpatial OCR lines: ${JSON.stringify(evidence.ocr.spatialLines.map(line => ({ text: line.text, bounds: line.bounds })))}. UI detector: ${JSON.stringify(evidence.detections)}. Section boundaries: ${JSON.stringify(evidence.inspection.horizontalColorChanges)}. Dominant colors: ${JSON.stringify(evidence.inspection.dominantColors)}. Supplied assets: ${JSON.stringify(assetCatalog.slice(0, 100))}. Basic component candidates (may include individual letters): ${JSON.stringify(evidence.componentCandidates.slice(0, 60))}.`;
  const response = await fetch(endpoint || 'https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [
      { role: 'user', content: [{ type: 'text', text: `${prompt}\nIf a second image is present, it is a contact sheet of supplied assets numbered in the same order as the first 48 catalog entries, left to right and top to bottom.` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } },
        ...(sheet ? [{ type: 'image_url', image_url: { url: `data:image/png;base64,${sheet.toString('base64')}` } }] : [])] },
    ] }),
  });
  if (!response.ok) throw new Error(`Vision request failed (${response.status}): ${(await response.text()).slice(0, 400)}`);
  const body = await response.json();
  const content = textContent(body.choices?.[0]?.message?.content).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return { inventory: JSON.parse(content), usage: body.usage ?? null, model: body.model ?? model };
}

function fallbackInventory({ screenshot, out, brief, inspection, ocr }) {
  const { width, height } = inspection;
  const separators = inspection.horizontalColorChanges.filter(item => item.delta >= 35 && item.y > 40 && item.y < height - 40)
    .sort((a, b) => a.y - b.y);
  const cuts = [0];
  for (const item of separators) if (item.y - cuts.at(-1) >= 60) cuts.push(item.y);
  if (height - cuts.at(-1) < 40) cuts.pop();
  cuts.push(height);
  const regions = cuts.slice(0, -1).map((start, index) => ({ id: `region-${index + 1}`, role: 'unclassified section',
    bounds: [0, start, width, cuts[index + 1] - start], parentId: null, confidence: 0.5,
    notes: 'Boundary suggested by a broad color change; classify from the screenshot.' }));
  const elements = (ocr.spatialLines || ocr.lines).map((line, index) => ({ id: `ocr-line-${index + 1}`, parentId: regions.find(region => line.bounds[1] >= region.bounds[1] && line.bounds[1] < region.bounds[1] + region.bounds[3])?.id ?? regions[0].id,
    kind: 'text', role: 'unclassified text', bounds: line.bounds, confidence: line.confidence, evidence: 'observed', text: line.text,
    notes: 'OCR candidate; verify wording and split grouped navigation or labels.' }));
  return { schemaVersion: '1.0', draft: true, source: { screenshot: path.relative(out, screenshot).replaceAll('\\', '/'), viewport: { width, height }, brief },
    regions, elements, assets: [], unknowns: [{ question: 'Which visible areas are controls, logos, images, video posters, or 3D content, and which OCR lines need correction?',
      relatedIds: regions.map(item => item.id), impact: 'A vision pass is required before code or asset routing.' }] };
}

export async function preparePage({ screenshot, out, briefPath, briefText, visionFile, model, endpoint, language = 'eng', detectorFile, detectorCommand, assetsDir, force = false }) {
  if (!screenshot || !out) throw new Error('prepare needs --screenshot and --out.');
  if (visionFile && model) throw new Error('Use either --vision-file or --model.');
  const started = performance.now();
  const source = path.resolve(screenshot), directory = path.resolve(out);
  const brief = briefPath ? await fs.readFile(path.resolve(briefPath), 'utf8') : briefText ?? '';
  const bytes = await fs.readFile(source);
  const visionBytes = visionFile ? await fs.readFile(path.resolve(visionFile)) : Buffer.alloc(0);
  const detectorBytes = detectorFile ? await fs.readFile(path.resolve(detectorFile)) : Buffer.alloc(0);
  const fingerprint = crypto.createHash('sha256').update(bytes).update(brief).update(visionBytes).update(detectorBytes)
    .update(model ?? '').update(language).update(JSON.stringify(detectorCommand || [])).digest('hex');
  const manifestPath = path.join(directory, 'prepare.json');
  if (!force && !assetsDir) {
    const old = await fs.readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null);
    if (old?.fingerprint === fingerprint && await fs.access(path.join(directory, 'evidence.json')).then(() => true).catch(() => false))
      return { ...old, reused: true };
  }
  await fs.mkdir(directory, { recursive: true });
  const [analyzed, assetCatalog] = await Promise.all([
    analyzeScreenshot({ screenshot: source, language, detectorFile, detectorCommand }),
    catalogAssets(assetsDir, directory),
  ]);
  const inspection = analyzed.inspection;
  const evidence = { ...analyzed, fingerprint, screenshot: source, brief };
  await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  await fs.writeFile(path.join(directory, 'asset-catalog.json'), JSON.stringify(assetCatalog, null, 2) + '\n');
  const contactSheet = await makeAssetContactSheet(assetCatalog, directory, path.join(directory, 'asset-contact-sheet.png'));
  let inventory = fallbackInventory({ screenshot: source, out: directory, brief, inspection, ocr: analyzed.ocr });
  let vision = { mode: 'none', status: 'needs-agent-vision' };
  if (visionFile) {
    inventory = JSON.parse(visionBytes.toString('utf8'));
    for (const asset of inventory.assets || []) if (asset.resolvedPath) {
      const original = path.resolve(path.dirname(path.resolve(visionFile)), asset.resolvedPath);
      asset.resolvedPath = path.relative(directory, original).replaceAll('\\', '/');
    }
    vision = { mode: 'file', status: 'supplied', source: path.resolve(visionFile) };
  } else if (model) {
    const result = await openRouterInventory({ screenshot: source, brief, evidence, model, endpoint, assetCatalog,
      contactSheet: contactSheet?.path });
    inventory = result.inventory;
    vision = { mode: 'openrouter', status: 'supplied', model: result.model, usage: result.usage };
  }
  inventory.source = { screenshot: path.relative(directory, source).replaceAll('\\', '/'), viewport: { width: inspection.width, height: inspection.height }, brief };
  const colorHints = vision.status === 'supplied' ? await enrichInventoryColors(inventory, source) : [];
  const inventoryFile = path.join(directory, vision.status === 'supplied' ? 'page-inventory.json' : 'page-inventory.draft.json');
  await fs.writeFile(inventoryFile, JSON.stringify(inventory, null, 2) + '\n');
  if (vision.status === 'supplied') await fs.writeFile(path.join(directory, 'inventory-audit.json'),
    JSON.stringify(auditInventory(inventory, evidence), null, 2) + '\n');
  const manifest = { fingerprint, screenshot: source, out: directory, evidence: path.join(directory, 'evidence.json'), inventory: inventoryFile,
    vision, assetCatalog: path.join(directory, 'asset-catalog.json'), contactSheet: contactSheet?.path || null,
    suppliedAssets: assetCatalog.length,
    colorHints: colorHints.length, elapsedMs: Math.round(performance.now() - started), reused: false };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
