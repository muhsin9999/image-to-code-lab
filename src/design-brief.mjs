import fs from 'node:fs/promises';
import path from 'node:path';
import { fontClass } from './fit.mjs';

const union = boxes => {
  const x = Math.min(...boxes.map(b => b[0])), y = Math.min(...boxes.map(b => b[1]));
  return [x, y, Math.max(...boxes.map(b => b[0] + b[2])) - x, Math.max(...boxes.map(b => b[1] + b[3])) - y];
};
const wording = i => i.reviewedText || i.lines?.map(l => l.text).join('\n') || '';
const clean = s => (typeof s === 'object' && s !== null ? JSON.stringify(s) : String(s ?? '')).replaceAll('|', '\\|').replace(/\r?\n/g, ' / ');

// Geometry supplies candidates, never claimed DOM structure or responsive ground truth.
export function structureEvidence(facts) {
  const groups = [], warnings = [];
  for (const section of facts.sections) {
    const items = section.items.filter(i => Array.isArray(i.box));
    for (const axis of [0, 1]) {
      const buckets = [];
      for (const item of items) {
        const bucket = buckets.find(b => Math.abs(b.position - item.box[axis]) <= 4);
        if (bucket) bucket.items.push(item.id); else buckets.push({ position: item.box[axis], items: [item.id] });
      }
      for (const b of buckets.filter(b => b.items.length >= 3)) groups.push({ kind: axis ? 'aligned-top' : 'aligned-left', section: section.id, ...b, source: 'measured', meaning: 'candidate relationship' });
    }
    const used = new Set();
    for (const item of items.filter(i => ['image', 'box'].includes(i.type))) {
      if (used.has(item.id)) continue;
      const peers = items.filter(i => i.type === item.type && !used.has(i.id) && Math.abs(i.box[2] - item.box[2]) <= Math.max(4, item.box[2] * .08) && Math.abs(i.box[3] - item.box[3]) <= Math.max(4, item.box[3] * .08));
      if (peers.length < 2) continue;
      peers.forEach(i => used.add(i.id));
      const row = peers.every(i => Math.abs(i.box[1] - item.box[1]) <= 5);
      peers.sort((a, b) => a.box[row ? 0 : 1] - b.box[row ? 0 : 1]);
      groups.push({ kind: 'repeated-size', section: section.id, items: peers.map(i => i.id), arrangement: row ? 'row' : 'undetermined',
        gaps: row ? peers.slice(1).map((i, n) => i.box[0] - peers[n].box[0] - peers[n].box[2]) : [], source: 'inferred', bounds: union(peers.map(i => i.box)) });
    }
    for (const i of items) {
      if (i.type === 'unread' || i.type === 'icon' && i.textLike) warnings.push({ id: i.id, kind: 'classification', reason: 'May be text. Review the region before coding.' });
      if (i.type === 'text' && (i.partial || i.sizeUnsure || i.ocrConfidence < .75)) warnings.push({ id: i.id, kind: 'text', reason: 'Wording or geometry is uncertain.' });
      if (i.type === 'text' && /heading/.test(i.role || '') && !i.familyReviewed) warnings.push({ id: i.id, kind: 'font-class', reason: `Confirm ${fontClass(i.family)} versus other font classes visually.` });
      if (i.type === 'image' && !i.file) warnings.push({ id: i.id, kind: 'asset', reason: i.route });
    }
  }
  return { version: 1, coordinateSystem: 'reference-page', groups, warnings,
    note: 'Pixel/ink bounds are not CSS content boxes. Groups are candidates; confirm semantic nesting visually.' };
}

export async function writeDesignBrief({ work, facts, plan, reviewHash = null }) {
  const evidence = structureEvidence(facts);
  const items = facts.sections.flatMap(s => s.items.map(i => ({ ...i, sectionId: s.id })));
  const containers = (plan?.containers || facts.sections.map(s => ({id: s.id, role: 'Unreviewed detected band', items: s.items.map(i => i.id), layout: 'Needs visual grouping', responsive: 'Needs inferred rules'})))
    .map(c => ({ ...c, selector:c.selector || `[data-i2c-container="${c.id}"]`, constraints:c.constraints || null, bounds: c.items.some(id => items.find(i => i.id === id)) ? union(c.items.map(id => items.find(i => i.id === id)?.box).filter(Boolean)) : null }));
  const covered = new Set(containers.flatMap(c => c.items));
  const brief = { version: 1, status: plan ? 'visually-reviewed' : 'provisional', reviewHash, viewport: facts.viewport,
    coordinateSystem: 'reference-page', containers, suppliedAssets: facts.supplied || [],
    elements: items.map(i => ({id:i.id, type:i.type, sectionId:i.sectionId, bounds:i.box, text:wording(i) || undefined,
      typography:i.type === 'text' ? {family:i.family, class:fontClass(i.family), size:i.size, weight:i.weight, lineHeight:i.lineHeight, spacing:i.spacing, candidates:i.fontCandidates,
        source:i.familyReviewed ? 'visually-reviewed' : 'estimated', geometryTrusted:i.geometryTrusted !== false} : undefined,
      color:i.color || i.fill, file:i.file, assetStatus:i.type === 'image' ? (i.file ? 'available-candidate' : 'unresolved') : undefined,
      source:i.reviewReason ? 'visually-reviewed' : 'measured-or-estimated', reason:i.reviewReason,
      required:i.required !== false})),
    evidence, uncertainties:plan?.uncertainties || [], interactions:plan?.interactions || [],
    breakpoints:plan?.breakpoints || [],
    warnings:[...evidence.warnings, ...items.filter(i => !covered.has(i.id)).map(i => ({id:i.id,kind:'ungrouped',reason:'No reviewed container owns this item.'}))] };
  const L = ['# Design brief', '', `Status: **${brief.status}**. Reference: ${facts.viewport.width} × ${facts.viewport.height}px.`,
    'Use this brief together with the original screenshot. Bounds describe visible pixels at the reference width; use flow/grid/flex relationships for CSS.',
    'Typography and mobile rules are estimates unless reviewed. A review is an agent judgment, not ground truth.', '', '## Components', ''];
  for (const c of containers) L.push(`- **${c.id}**${c.parentId ? ` inside ${c.parentId}` : ''}: ${c.role}. Items: ${c.items.join(', ')}.`, `  Layout: ${c.layout}. Responsive: ${c.responsive}. Selector: ${c.selector}. Constraints: ${JSON.stringify(c.constraints)}.`);
  if (brief.suppliedAssets.length) L.push('', '## Supplied originals', '', ...brief.suppliedAssets.map(a => `- ${a.path}: ${a.width} × ${a.height}px. Confirm identity visually; use the path as reuse sourceId.`));
  L.push('', '## Elements', '', '| ID | Type / content | Reference bounds | Style / asset | Evidence |', '|---|---|---|---|---|');
  for (const i of brief.elements) L.push(`| ${i.id} | ${i.type}: ${clean(i.text || '')} | ${i.bounds?.join(', ')} | ${clean(i.typography ? `${i.typography.family || 'undecided'}; ${i.typography.size || '?'}px; ${i.typography.weight || '?'}; line height ${i.typography.lineHeight || 'infer'}` : i.file || i.color || i.assetStatus || '')} | ${i.source} |`);
  L.push('', '## Decisions still requiring attention', '', ...brief.warnings.map(w => `- ${w.id}: ${w.reason}`), ...brief.uncertainties.map(u => `- ${clean(u)}`),
    '', '## Interaction expectations', '', ...(brief.interactions.length ? brief.interactions.map(i => `- ${i.selector}: ${i.action}; expected ${clean(i.expect || 'record outcome')}`) : ['No interactions specified. Do not claim functional commerce, navigation or submission from appearance alone.']),
    '', 'Full candidates, relationships and provenance: design-brief.json. Batch font measurements: font-measurements.json.');
  await fs.writeFile(path.join(work, 'structure-evidence.json'), JSON.stringify(evidence,null,2));
  await fs.writeFile(path.join(work, 'design-brief.json'), JSON.stringify(brief,null,2));
  await fs.writeFile(path.join(work, 'design-brief.md'), L.join('\n')+'\n');
  return brief;
}
