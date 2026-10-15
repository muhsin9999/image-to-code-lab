import fs from 'node:fs/promises';
import path from 'node:path';

const tokens = value => String(value || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];

/** Diagnose omissions before rendering; OCR is noisy, so warnings are advisory. */
export function auditInventory(inventory, evidence) {
  const elements = inventory.elements || [];
  const visibleText = new Set(elements.flatMap(item => tokens(item.text)));
  const observed = (evidence.ocr?.words || []).filter(item => item.confidence >= .7)
    .flatMap(item => tokens(item.text));
  const missing = [...new Set(observed.filter(word => !visibleText.has(word)))];
  const text = elements.filter(item => item.kind === 'text' || item.kind === 'control');
  const styled = text.filter(item => item.style?.fontFamily || item.style?.font || item.style?.fontSize).length;
  const unresolved = (inventory.assets || []).filter(item => !item.resolvedPath && item.route !== 'code' && item.route !== 'library');
  const warnings = [];
  if (observed.length >= 10 && missing.length / new Set(observed).size > .25)
    warnings.push('Many confident OCR words are absent from the inventory. Review the marked words and column grouping.');
  if (text.length >= 5 && styled / text.length < .3)
    warnings.push('Typography is largely unspecified. Estimate shared font families, sizes and line heights before the first render.');
  if (unresolved.length) warnings.push(`${unresolved.length} asset slots remain unresolved; check the supplied-asset catalog first.`);
  if (!evidence.detections?.length) warnings.push('No semantic UI detector ran. Component boxes are only pixel candidates; the vision pass must classify controls and hierarchy.');
  return { textElements: text.length, styledTextElements: styled, ocrWords: observed.length,
    missingOcrWords: missing.slice(0, 40), unresolvedAssets: unresolved.map(item => item.id),
    semanticDetections: evidence.detections?.length || 0, warnings };
}

export async function saveInventoryAudit({ inventoryFile, evidenceFile, out }) {
  const [inventory, evidence] = await Promise.all([inventoryFile, evidenceFile].map(file => fs.readFile(path.resolve(file), 'utf8').then(JSON.parse)));
  const report = auditInventory(inventory, evidence);
  await fs.writeFile(path.resolve(out), JSON.stringify(report, null, 2) + '\n');
  return report;
}
