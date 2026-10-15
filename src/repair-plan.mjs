import fs from 'node:fs/promises';
import path from 'node:path';

const area = box => Array.isArray(box) ? box[2] * box[3] : 0;

/** Rank broad visual faults before isolated glyph or one-pixel adjustments. */
export async function makeRepairPlan({ reportFile, inventoryFile, remaining, timeRemainingMinutes }) {
  const report = JSON.parse(await fs.readFile(path.resolve(reportFile), 'utf8'));
  const inventory = JSON.parse(await fs.readFile(path.resolve(inventoryFile), 'utf8'));
  const elements = new Map((inventory.elements || []).map(item => [item.id, item]));
  const assets = new Map((inventory.assets || []).map(item => [item.id, item]));
  const actions = [];
  for (const image of report.pageHealth?.brokenImages || [])
    actions.push({ priority: 0, type: 'broken-image', target: image.src, action: 'Fix this image path or use the supplied original.' });
  if (report.pageHealth?.horizontalOverflow) actions.push({ priority: 0, type: 'overflow',
    action: 'Remove horizontal overflow at the target viewport.' });

  const media = (report.assetRegions || []).filter(item => item.meanColorError > .1)
    .map(item => ({ ...item, impact: area(item.bounds) * item.meanColorError }))
    .sort((a, b) => b.impact - a.impact);
  if (media.length) actions.push({ priority: 1, type: 'media-mismatch', targets: media.slice(0, 3).map(item => ({
    id: item.id, bounds: item.bounds, route: assets.get(item.id)?.route, error: item.meanColorError })),
    action: 'Match these visible asset slots to supplied originals first. If the target itself is a flat placeholder, reproduce its measured fill. Keep genuinely missing media explicit.' });

  const regions = (report.regions || []).map(item => ({ ...item, impact: area(item.bounds) * item.meanColorError }))
    .sort((a, b) => b.impact - a.impact);
  if (regions[0]?.impact > 1000) actions.push({ priority: 1, type: 'region-visual', targets: regions.slice(0, 3).map(item => ({
    id: item.id, bounds: item.bounds, error: item.meanColorError })),
    action: 'Fix broad background, border, alignment and spacing differences in these regions together.' });

  const checks = report.textChecks || [];
  const widthErrors = checks.filter(item => item.present && item.boundsDelta && item.targetBounds?.[2] >= 40 &&
    Math.abs(item.boundsDelta[2]) >= Math.max(12, item.targetBounds[2] * .12));
  if (widthErrors.length >= 3) actions.push({ priority: 1, type: 'systemic-typography',
    targets: widthErrors.slice(0, 6).map(item => ({ id: item.id, widthDelta: item.boundsDelta[2] })),
    action: 'The same font or size error affects several text blocks. Correct the shared font family, size and line height before moving individual elements.' });

  const missing = checks.filter(item => !item.present);
  if (missing.length) actions.push({ priority: 2, type: 'missing-text', targets: missing.slice(0, 6).map(item => ({
    id: item.id, text: elements.get(item.id)?.text || '' })), action: 'Render these exact visible strings.' });
  const geometry = checks.filter(item => item.present && item.boundsDelta && Math.max(...item.boundsDelta.map(Math.abs)) > 8)
    .sort((a, b) => Math.max(...b.boundsDelta.map(Math.abs)) - Math.max(...a.boundsDelta.map(Math.abs)));
  if (geometry.length) actions.push({ priority: 3, type: 'text-geometry', targets: geometry.slice(0, 6).map(item => ({
    id: item.id, delta: item.boundsDelta })), action: 'After shared typography is corrected, adjust these remaining text positions and wraps together.' });

  actions.sort((a, b) => a.priority - b.priority);
  return { run: report.run, remaining, timeRemainingMinutes,
    layoutDifference: report.visualScores?.layout?.differingFraction ?? null,
    mediaDifference: report.visualScores?.media?.differingFraction ?? null,
    actions: actions.slice(0, 4),
    instruction: remaining > 0 && (timeRemainingMinutes == null || timeRemainingMinutes > 0)
      ? 'Apply the broad corrections in one batch, rebuild, then compare once. Use existing measurements; do not create custom probe scripts for minor offsets.'
      : 'Stop this pass and report the best saved render and unresolved issues.' };
}
