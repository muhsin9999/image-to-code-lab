import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateConstraints } from './component-check.mjs';
import { requireDependency } from './common.mjs';
import { writeDesignBrief } from './design-brief.mjs';
import { ensureReviewedFonts, measureFontBatch } from './batch-metrics.mjs';

const sharp = requireDependency('sharp');
const intersects = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const validBox = (b, v) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] >= 0 && b[1] >= 0 && b[2] > 0 && b[3] > 0 && b[0] + b[2] <= v.width && b[1] + b[3] <= v.height;
const nameOk = id => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id);

export function assetAudit(facts) {
  const images = facts.sections.flatMap(s => s.items).filter(i => i.type === 'image');
  return {
    unresolved: images.filter(i => !i.file).map(i => ({ id: i.id, reason: i.route || 'No source image available.' })),
    overlaps: images.flatMap((a, n) => images.slice(n + 1).filter(b => a.file && b.file && intersects(a.box, b.box)).map(b => [a.id, b.id])),
    replacementCandidates: images.flatMap((a,n)=>images.slice(n+1).filter(b=>intersects(a.box,b.box) && (!a.file || !b.file)).map(b=>({ids:[a.id,b.id],action:'Review whether the newer asset replaces the old detection. Add replaces explicitly; overlap alone does not prove identity.'}))),
    note: 'Overlapping crops can be intentional layers or merged components. Visually confirm independent images before reflowing them.'
  };
}

export function reconcileFacts(raw, plan) {
  if (plan.version !== 1 || !Array.isArray(plan.containers) || !plan.containers.length) throw new Error('Review plan needs version:1 and at least one container with layout and responsive decisions.');
  const facts = structuredClone(raw), all = facts.sections.flatMap(s => s.items), byId = new Map(all.map(i => [i.id, i]));
  const types = ['text', 'image', 'icon', 'box', 'line', 'gradient', 'unread'];
  const retire = ids => { for (const id of ids || []) { if (!byId.has(id)) throw new Error(`Unknown replaced item ${id}.`); byId.get(id).ignored = true; } };
  const asText = (item, correction) => {
    if (typeof correction.text !== 'string' || !correction.text.trim()) throw new Error(`Text correction invalid for ${item.id}.`);
    if (item.type !== 'text') {
      const style = byId.get(correction.styleLike || item.textLike) || {};
      for (const k of ['family', 'familyId', 'weight', 'size', 'lineHeight', 'spacing', 'metrics']) item[k] ??= style[k];
      item.originalType = item.type; item.type = 'text'; delete item.file; delete item.fileBox;
      item.size ??= Math.max(10, item.box[3] / correction.text.split('\n').length); item.weight ??= 400; item.family ??= 'Arial';
    }
    item.reviewedText = correction.text; item.geometryTrusted = false; item.partial = false;
    item.lines = correction.text.split(/\r?\n/).map(text => ({ text, box: [...item.box], baseline: item.box[1] + item.box[3], size: item.size }));
  };
  for (const add of plan.additions || []) {
    if (!nameOk(add.id) || byId.has(add.id) || !types.includes(add.type) || !validBox(add.box, facts.viewport) || !add.reason?.trim()) throw new Error(`Addition ${add.id} needs new id, supported type, valid box and reason.`);
    const section = add.sectionId ? facts.sections.find(s => s.id === add.sectionId) : facts.sections.find(s => add.box[1] >= s.y && add.box[1] < s.y + s.height);
    if (!section) throw new Error(`Addition ${add.id} needs a known sectionId.`);
    const item = { id: add.id, type: add.type, box: add.box, reviewReason: add.reason, geometryTrusted: false };
    if (add.type === 'text') { item.type = 'unread'; asText(item, add); }
    for (const k of ['family', 'weight', 'size', 'color', 'role', 'required']) if (add[k] !== undefined) item[k] = add[k];
    if (add.family) item.familyReviewed = true;
    if (add.type === 'image') item.route = 'unresolved reviewed image; supply an asset decision';
    section.items.push(item); byId.set(item.id, item); retire(add.replaces);
  }
  const containerIds = new Set();
  for (const c of plan.containers) {
    if (!nameOk(c.id) || containerIds.has(c.id) || !c.role?.trim() || !c.layout?.trim() || !c.responsive?.trim() || !Array.isArray(c.items)) throw new Error('Each container needs a unique id, role, items, layout and responsive description.');
    for (const id of c.items) if (!byId.has(id) && !(plan.assets || []).some(a => a.id === id)) throw new Error(`Unknown measured item ${id} in ${c.id}.`);
    validateConstraints(c);
    containerIds.add(c.id);
  }
  for (const c of plan.containers) {
    const seen = new Set([c.id]); let parent = c.parentId;
    while (parent) { if (!containerIds.has(parent) || seen.has(parent)) throw new Error(`Invalid or cyclic parentId for ${c.id}.`); seen.add(parent); parent = plan.containers.find(c => c.id === parent).parentId; }
  }
  if (plan.breakpoints && (!Array.isArray(plan.breakpoints) || plan.breakpoints.some(w => !Number.isInteger(w) || w < 240 || w > 3840))) throw new Error('breakpoints must contain CSS widths from 240 to 3840.');
  const corrected = new Set();
  for (const correction of plan.corrections || []) {
    const item = byId.get(correction.id);
    if (!item || corrected.has(item.id) || !correction.reason?.trim()) throw new Error(`Correction ${correction.id} needs a known unique id and a visual reason.`);
    corrected.add(item.id);
    if (correction.ignore) { item.ignored = true; continue; }
    if (correction.box !== undefined) { if (!validBox(correction.box, facts.viewport)) throw new Error(`Invalid box for ${item.id}.`); item.box = correction.box; item.geometryTrusted = false; }
    if (correction.type && !types.includes(correction.type)) throw new Error(`Unsupported type for ${item.id}.`);
    if (correction.text !== undefined || correction.type === 'text') asText(item, { ...correction, text: correction.text ?? item.reviewedText ?? item.lines?.map(l => l.text).join('\n') });
    else if (correction.type && correction.type !== item.type) { item.originalType = item.type; item.type = correction.type; delete item.lines; delete item.reviewedText; delete item.file; delete item.fileBox; item.geometryTrusted = false; }
    for (const key of ['family', 'weight', 'size', 'lineHeight', 'spacing', 'color', 'role']) if (correction[key] !== undefined) item[key] = correction[key];
    for (const key of ['size', 'lineHeight']) if (item[key] != null && (!Number.isFinite(item[key]) || item[key] <= 0)) throw new Error(`Invalid ${key} for ${item.id}.`);
    if (correction.family) { item.familyReviewed = true; delete item.familyId; }
    if (correction.geometryTrusted === false) item.geometryTrusted = false;
    if (correction.required !== undefined) item.required = Boolean(correction.required);
    item.reviewReason = correction.reason;
    retire(correction.replaces);
  }
  for (const s of facts.sections) s.items = s.items.filter(i => !i.ignored);
  facts.review = { containers: plan.containers.map(c => ({ ...c, items: c.items.filter(id => !byId.get(id)?.ignored) })), uncertainties: plan.uncertainties || [], interactions: plan.interactions || [], breakpoints: plan.breakpoints || [], visualReview: 'agent', coordinateSystem: 'page' };
  return facts;
}

export async function applyReview({ state, planFile }) {
  const raw = JSON.parse(await fs.readFile(path.join(state.work, 'facts.json'), 'utf8'));
  const planText = await fs.readFile(path.resolve(planFile), 'utf8');
  const plan = JSON.parse(planText), facts = reconcileFacts(raw, plan);
  const items = facts.sections.flatMap(s => s.items), rawItems = new Map(items.map(i => [i.id, i]));
  const crops = [], ids = new Set(), replaced = new Set();
  // Retire only an unambiguous same-box detection automatically; overlaps need review.
  for (const asset of plan.assets || []) if (!asset.replaces && Array.isArray(asset.box)) {
    const matches=items.filter(i=>i.type==='image' && i.box.every((n,k)=>Math.abs(n-asset.box[k])<=2));
    if(matches.length===1 && (plan.assets||[]).filter(a=>a.box?.every((n,k)=>Math.abs(n-asset.box[k])<=2)).length===1) { asset.replaces=[matches[0].id]; asset.replacementSource='unique-same-box'; }
  }
  // Validate the complete batch before creating assets or updating the review.
  for (const asset of plan.assets || []) {
    if (!nameOk(asset.id) || ids.has(asset.id) || rawItems.has(asset.id) || !asset.reason?.trim()) throw new Error(`Asset ${asset.id} needs a new unique id and a reason.`);
    ids.add(asset.id);
    if (!['crop', 'reuse', 'placeholder'].includes(asset.decision) || !validBox(asset.box, raw.viewport)) throw new Error(`Asset ${asset.id} needs decision crop/reuse/placeholder and a valid page box.`);
    if (asset.replaces) for (const id of asset.replaces) {
      if (rawItems.get(id)?.type !== 'image') throw new Error(`Cannot replace non-image ${id}.`);
      replaced.add(id);
    }
    if (asset.decision === 'crop') {
      const conflict = items.find(i => i.type === 'text' && intersects(i.box, asset.box));
      if (conflict) throw new Error(`Crop ${asset.id} overlaps live text ${conflict.id}. Use an original or an unresolved placeholder; do not paint text out.`);
      const fragment = (asset.replaces || []).map(id => rawItems.get(id)).find(i => i.behindText && asset.box[2] * asset.box[3] < .9 * i.box[2] * i.box[3]);
      if (fragment) throw new Error(`Crop ${asset.id} is a fragment of background ${fragment.id}. Use an original/reuse or placeholder; enlarging it changes composition.`);
      crops.push(asset);
    }
    if (asset.decision === 'reuse' && !rawItems.get(asset.sourceId)?.file && !(raw.supplied || []).some(a => a.path === asset.sourceId)) throw new Error(`Reuse ${asset.id} needs a sourceId with an available image or supplied path.`);
  }
  await fs.mkdir(path.join(state.work, 'assets'), { recursive: true });
  await fs.mkdir(path.join(state.site, 'public/assets'), { recursive: true });
  for (const crop of crops) {
    const [left, top, width, height] = crop.box.map(Math.round);
    await sharp(state.screenshot).extract({ left, top, width, height }).png().toFile(path.join(state.work, 'assets', `${crop.id}.png`));
  }
  for (const s of facts.sections) s.items = s.items.filter(i => !replaced.has(i.id));
  for (const asset of plan.assets || []) {
    const supplied = (raw.supplied || []).find(a => a.path === asset.sourceId);
    const file = asset.decision === 'crop' ? `assets/${asset.id}.png` : asset.decision === 'reuse' ? rawItems.get(asset.sourceId)?.file || `assets/${asset.id}${path.extname(supplied.path)}` : null;
    if (asset.decision === 'reuse' && supplied && !rawItems.get(asset.sourceId)?.file) await fs.copyFile(path.resolve(state.work, supplied.path), path.join(state.work, file));
    const section = facts.sections.find(s => asset.box[1] >= s.y && asset.box[1] < s.y + s.height) || facts.sections[0];
    section.items.push({ id: asset.id, type: 'image', box: asset.box, file, route: asset.decision, reviewReason: asset.reason });
    if (file) { await fs.mkdir(path.dirname(path.join(state.site, 'public', file)), { recursive: true }); await fs.copyFile(path.join(state.work, file), path.join(state.site, 'public', file)); }
  }
  for (const c of facts.review.containers) {
    const newIds = (plan.assets || []).filter(a => (a.replaces || []).some(id => c.items.includes(id))).map(a => a.id);
    c.items = [...new Set([...c.items.filter(id => !replaced.has(id)), ...newIds])];
  }
  const inventory = JSON.parse(await fs.readFile(path.join(state.work, 'page-inventory.json'), 'utf8'));
  inventory.elements = []; inventory.assets = [];
  for (const section of facts.sections) for (const item of section.items) {
    const e = { id: item.id, parentId: facts.review.containers.find(c => c.items.includes(item.id))?.id || section.id,
      kind: item.type === 'text' ? 'text' : item.type === 'image' ? 'media' : item.type === 'icon' ? 'icon' : 'container', role: item.role || item.type, bounds: item.box };
    if (item.type === 'text') e.text = item.reviewedText || item.lines.map(l => l.text).join(' ');
    if (item.type === 'image') { e.assetId = item.id; inventory.assets.push({id:item.id,elementId:item.id,kind:'image',route:item.file?'extract':'unresolved',resolvedPath:item.file,description:item.reviewReason || item.route}); }
    inventory.elements.push(e);
  }
  const audit = assetAudit(facts);
  const reviewedAt = new Date().toISOString(), hash = crypto.createHash('sha256').update(planText).digest('hex');
  await ensureReviewedFonts(facts, state.work, state.site);
  const metrics = await measureFontBatch({ work: state.work, facts });
  await writeDesignBrief({ work: state.work, facts, plan: { ...plan, containers: facts.review.containers }, reviewHash: hash });
  const revision = path.join(state.work, 'reviews', `${reviewedAt.replace(/[:.]/g, '-')}-${hash.slice(0, 8)}`);
  await fs.mkdir(revision, { recursive: true });
  await fs.writeFile(path.join(revision, 'layout-plan.json'), planText);
  await fs.writeFile(path.join(revision, 'reviewed-facts.json'), JSON.stringify(facts, null, 2));
  await fs.writeFile(path.join(state.work, 'reviewed-facts.json'), JSON.stringify(facts, null, 2));
  await fs.writeFile(path.join(state.work, 'reviewed-inventory.json'), JSON.stringify(inventory, null, 2));
  await fs.writeFile(path.join(state.work, 'layout-plan.json'), planText);
  await fs.writeFile(path.join(state.work, 'asset-audit.json'), JSON.stringify(audit, null, 2));
  await fs.writeFile(path.join(state.work, 'asset-reconciliation.json'),JSON.stringify((plan.assets||[]).map(a=>({id:a.id,replaces:a.replaces||[],source:a.replacementSource||'explicit-review'})),null,2));
  await fs.writeFile(path.join(state.work, 'review.md'), [
    '# Reviewed page plan', '', 'All measured coordinates are relative to the page. Containers use normal flow; never add page y to section y.', '',
    ...plan.containers.map(c => `- ${c.id} (${c.role}): ${c.layout} Smaller widths: ${c.responsive}`), '',
    ...((plan.corrections || []).map(c => `- ${c.id}: ${c.ignore ? 'ignored' : c.text || c.family || 'geometry uncertain'} — ${c.reason}`)), '',
    ...audit.unresolved.map(a => `- UNRESOLVED ${a.id}: ${a.reason}`),
    ...audit.overlaps.map(ids => `- REVIEW OVERLAP ${ids.join(', ')}: confirm these are independent usable assets.`), '',
    'Visual review is an agent decision, not verified ground truth. Inspect the rendered page before accepting it.'
  ].join('\n'));
  return { reviewedAt, hash, containers: plan.containers.length, corrections: (plan.corrections || []).length, assets: audit, metrics, brief: path.join(state.work, 'design-brief.md'), next: 'Read design-brief.md with the screenshot, build components, then fast check.' };
}
