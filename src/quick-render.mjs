import fs from 'node:fs/promises';
import path from 'node:path';

const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const cssColor = value => {
  const text = String(value || '');
  return /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i.exec(text)?.[0] ||
    /\b(?:transparent|white|black)\b/i.exec(text)?.[0] || null;
};
const boxCss = bounds => bounds ? `left:${bounds[0]}px;top:${bounds[1]}px;width:${bounds[2]}px;height:${bounds[3]}px;` : '';
const colorIsDark = value => {
  if (value === 'black') return true;
  const match = /^#([0-9a-f]{6})$/i.exec(value || '');
  if (!match) return false;
  const n = match[1];
  return (parseInt(n.slice(0, 2), 16) * 0.2126 + parseInt(n.slice(2, 4), 16) * 0.7152 + parseInt(n.slice(4, 6), 16) * 0.0722) < 115;
};
function fontSize(element) {
  const role = String(element.role || '').toLowerCase();
  const height = element.bounds?.[3] || 24;
  if (/headline|hero title|display/.test(role)) return Math.max(32, Math.min(88, Math.round(Math.min(height * 0.43, (element.bounds?.[2] || 500) / Math.max(5, String(element.text || '').length / 1.65) * 2.1))));
  if (/paragraph|body|description|intro/.test(role)) return 20;
  if (/eyebrow|overline|tagline/.test(role)) return 13;
  if (/logo|wordmark/.test(role)) return Math.max(15, Math.min(30, Math.round(height * 0.8)));
  if (/title|heading/.test(role)) return Math.max(20, Math.min(48, Math.round(height * 0.85)));
  return Math.max(14, Math.min(22, Math.round(height * 0.75)));
}
function ownerRegion(element, regions, elements) {
  const byId = new Map(elements.map(item => [item.id, item]));
  const regionIds = new Set(regions.map(item => item.id));
  let parent = element.parentId;
  while (parent && !regionIds.has(parent)) parent = byId.get(parent)?.parentId;
  return regions.find(region => region.id === parent);
}

export async function renderQuickPage({ inventoryFile, out, evidenceFile }) {
  const inventory = JSON.parse(await fs.readFile(path.resolve(inventoryFile), 'utf8'));
  const evidence = evidenceFile ? JSON.parse(await fs.readFile(path.resolve(evidenceFile), 'utf8')) : null;
  const { width, height } = inventory.source.viewport;
  const base = inventory.style?.background || evidence?.inspection?.dominantColors?.[0]?.color || '#ffffff';
  const regions = inventory.regions || [], elements = inventory.elements || [];
  const assets = new Map((inventory.assets || []).map(asset => [asset.id, asset]));
  const backgrounds = regions.map(region => {
    const color = cssColor(region.style?.background);
    return color && region.bounds ? `<div class="region" data-i2c-id="${escapeHtml(region.id)}" style="${boxCss(region.bounds)}background:${color}"></div>` : '';
  }).join('');
  const rendered = [];
  for (const element of elements) {
    if (!element.bounds) continue;
    const region = ownerRegion(element, regions, elements);
    const regionColor = cssColor(region?.style?.background);
    const ink = colorIsDark(regionColor) ? '#f5f2ec' : '#171514';
    const role = String(element.role || '').toLowerCase();
    const styleColor = cssColor(element.style?.color) || ink;
    const fill = cssColor(element.style?.background);
    const border = typeof element.style?.border === 'string' ? element.style.border : null;
    const baseStyle = boxCss(element.bounds) + `color:${styleColor};` +
      (fill ? `background:${fill};` : '') + (border ? `border:${escapeHtml(border)};` : '');
    const id = escapeHtml(element.id);
    if (element.kind === 'media' || element.kind === 'icon') {
      const asset = assets.get(element.assetId);
      let src = null;
      if (asset?.resolvedPath) {
        const file = path.resolve(path.dirname(path.resolve(inventoryFile)), asset.resolvedPath);
        const bytes = await fs.readFile(file).catch(() => null);
        if (bytes) {
          const ext = path.extname(file).toLowerCase();
          const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
          src = `data:${mime};base64,${bytes.toString('base64')}`;
        }
      }
      rendered.push({ layer: element.kind === 'media' ? 1 : 3, html: src
        ? `<img class="item media" data-i2c-id="${id}" alt="" src="${src}" style="${baseStyle}"/>`
        : `<div class="item ${element.kind === 'media' ? 'media pending' : 'icon pending'}" data-i2c-id="${id}" style="${baseStyle}"></div>` });
      continue;
    }
    if (element.kind === 'text' || element.kind === 'control') {
      const size = Number(element.style?.fontSize) || fontSize(element);
      const face = escapeHtml(element.style?.fontFamily || inventory.style?.fontFamily || 'Arial,Helvetica,sans-serif');
      const weight = element.style?.fontWeight ? `font-weight:${escapeHtml(element.style.fontWeight)};` : '';
      const lh = element.style?.lineHeight;
      const lineHeight = lh ? `line-height:${escapeHtml(typeof lh === 'number' && lh > 3 ? `${lh}px` : lh)};` : '';
      const textStyle = `${baseStyle}font-size:${size}px;font-family:${face};${weight}${lineHeight}`;
      const content = escapeHtml(element.text);
      const button = element.kind === 'control' && /button|pill|cta/.test(role);
      const tag = button ? 'button' : element.kind === 'control' ? 'a' : 'div';
      const attr = tag === 'button' ? ' type="button"' : tag === 'a' ? ' href="#"' : '';
      rendered.push({ layer: 3, html: `<${tag}${attr} class="item ${button ? 'button' : 'text'}" data-i2c-id="${id}" style="${textStyle}">${content}</${tag}>` });
      continue;
    }
    rendered.push({ layer: 2, html: `<div class="item decoration" data-i2c-id="${id}" style="${baseStyle}"></div>` });
  }
  rendered.sort((a, b) => a.layer - b.layer);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>First render</title><style>
*{box-sizing:border-box}html,body{margin:0}body{background:${base};color:#222}.page{position:relative;width:${width}px;height:${height}px;overflow:hidden}.region,.item{position:absolute}.media{object-fit:cover}.media.pending{background:rgba(120,110,100,.09)}.icon.pending{background:rgba(120,110,100,.09)}.text{margin:0;white-space:pre-wrap;line-height:normal;overflow:visible}.button{display:flex;align-items:center;justify-content:center;border:0;border-radius:0;background:transparent;padding:0;cursor:pointer;white-space:nowrap}.decoration{border-left:1px solid currentColor;opacity:.2}a{text-decoration:none}
</style></head><body><main class="page">${backgrounds}${rendered.map(item => item.html).join('')}</main></body></html>`;
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(path.resolve(out), html);
  return { file: path.resolve(out), regions: regions.length, elements: elements.length, assets: assets.size,
    pendingAssets: [...assets.values()].filter(asset => !asset.resolvedPath).length, width, height };
}
