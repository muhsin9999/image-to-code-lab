import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { useIcon } from './icons.mjs';
import { enrichInventoryColors } from './design-hints.mjs';
import { inspectScreenshot } from './inspect.mjs';
import { resolveDependency } from './common.mjs';

const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates/react-vite');
const exists = file => fs.access(file).then(() => true).catch(() => false);

function ownerRegion(element, regions, elements) {
  const parents = new Map(elements.map(item => [item.id, item.parentId]));
  const regionIds = new Set(regions.map(item => item.id));
  let id = element.parentId;
  while (id && !regionIds.has(id)) id = parents.get(id);
  return regions.find(item => item.id === id) || regions[0];
}

function run(program, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('exit', code => code ? reject(new Error(`${program} ${args.join(' ')} failed: ${output.slice(-1500)}`)) : resolve(output));
  });
}

export async function syncReactAssets({ inventoryFile, siteDir, updatePageData = true }) {
  const inventory = JSON.parse(await fs.readFile(path.resolve(inventoryFile), 'utf8'));
  const site = path.resolve(siteDir);
  const assetDir = path.join(site, 'public', 'assets');
  await fs.mkdir(assetDir, { recursive: true });
  const assetMap = {};
  for (const asset of inventory.assets || []) {
    let file = asset.resolvedPath ? path.resolve(path.dirname(path.resolve(inventoryFile)), asset.resolvedPath) : null;
    if (!file && asset.kind === 'icon' && asset.route === 'library' && asset.libraryName) {
      const iconFile = path.join(assetDir, `${asset.id}.svg`);
      try { await useIcon(asset.libraryName, iconFile); file = iconFile; }
      catch { file = null; }
    }
    if (file && await exists(file)) {
      const destination = path.join(assetDir, `${asset.id}${path.extname(file).toLowerCase() || '.png'}`);
      if (path.resolve(file) !== path.resolve(destination)) await fs.copyFile(file, destination);
      assetMap[asset.id] = `./assets/${path.basename(destination)}`;
    }
  }
  const dataFile = path.join(site, 'src', 'page-data.json');
  if (updatePageData && await exists(dataFile)) {
    const data = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    data.assets = assetMap;
    await fs.writeFile(dataFile, JSON.stringify(data, null, 2) + '\n');
  }
  return assetMap;
}

/** Generate the editable React candidate that the first comparison will capture. */
export async function generateReactSite({ inventoryFile, siteDir, evidenceFile }) {
  const inventory = JSON.parse(await fs.readFile(path.resolve(inventoryFile), 'utf8'));
  const screenshot = path.resolve(path.dirname(path.resolve(inventoryFile)), inventory.source.screenshot);
  const evidence = evidenceFile ? JSON.parse(await fs.readFile(path.resolve(evidenceFile), 'utf8')) :
    { inspection: await inspectScreenshot(screenshot) };
  await enrichInventoryColors(inventory, screenshot);
  const site = path.resolve(siteDir);
  const marker = path.join(site, '.image-to-code-generated');
  if (await exists(site) && !await exists(marker)) {
    const entries = await fs.readdir(site);
    if (entries.some(entry => entry !== 'node_modules')) throw new Error(`Site directory already has files: ${site}. Choose an empty directory.`);
  }
  await fs.mkdir(site, { recursive: true });
  await fs.cp(template, site, { recursive: true, force: false, filter: source => !source.split(path.sep).includes('node_modules') });
  await fs.writeFile(marker, 'Generated from a page inventory. Edit src/main.tsx and src/style.css to refine this page.\n');
  await fs.mkdir(path.join(site, 'public', 'assets'), { recursive: true });
  const fontDir = path.join(site, 'src', 'fonts');
  await fs.mkdir(fontDir, { recursive: true });
  for (const weight of [400, 700]) {
    const sourceFont = path.join(path.dirname(resolveDependency('@fontsource/bodoni-moda')),
      'files', `bodoni-moda-latin-${weight}-normal.woff2`);
    await fs.copyFile(sourceFont, path.join(fontDir, `bodoni-moda-${weight}.woff2`));
  }
  const assetMap = await syncReactAssets({ inventoryFile, siteDir: site, updatePageData: false });
  const regions = inventory.regions || [];
  const elements = (inventory.elements || []).map(item => ({ ...item, ownerRegionId: ownerRegion(item, regions, inventory.elements || [])?.id }));
  const serifHints = elements.filter(item => /serif/i.test(item.style?.font || '')).length;
  const pageData = { viewport: inventory.source.viewport, regions, elements, assets: assetMap,
    theme: { background: inventory.style?.background || evidence?.inspection?.dominantColors?.[0]?.color || '#ffffff',
      fontFamily: inventory.style?.fontFamily || (serifHints >= 2 ? 'Georgia, serif' : 'Arial, Helvetica, sans-serif') } };
  await fs.writeFile(path.join(site, 'src', 'page-data.json'), JSON.stringify(pageData, null, 2) + '\n');
  const main = `import React from 'react';
import { createRoot } from 'react-dom/client';
import page from './page-data.json';
import './style.css';

type Box = [number, number, number, number];
type Entry = { id:string; parentId?:string|null; ownerRegionId?:string; kind:string; role:string; text?:string; bounds?:Box|null; assetId?:string; style?:Record<string, unknown> };
const regions = page.regions as unknown as Entry[];
const entries = page.elements as unknown as Entry[];
const byId = new Map<string, Entry>([...regions, ...entries].map(item => [item.id, item]));
const assets = page.assets as Record<string,string>;
function inferredSize(item:Entry):number {
  const role = (item.role || '').toLowerCase();
  const height = item.bounds?.[3] || 24;
  const width = item.bounds?.[2] || 500;
  if (item.kind === 'control') {
    if (/navigation|menu|sidebar/.test(role)) return 16;
    if (/input|field|textarea|select|search/.test(role)) return Math.max(13, Math.min(19, Math.round(height * .36)));
    if (/button|submit|cta/.test(role)) return Math.max(14, Math.min(20, Math.round(height * .36)));
    return Math.max(13, Math.min(18, Math.round(height * .8)));
  }
  if (/paragraph|body|description|intro/.test(role)) {
    const length = (item.text || '').length;
    let best = 16, error = Infinity;
    for (let size = 11; size <= 24; size++) {
      const lines = Math.max(1, Math.ceil(length * size * .52 / Math.max(1, width)));
      const difference = Math.abs(lines * size * 1.38 - height);
      if (difference < error) { best = size; error = difference; }
    }
    return best;
  }
  if (/headline|hero title|display|page title/.test(role)) return Math.max(24, Math.min(88, Math.round(height * .92)));
  if (/eyebrow|overline|tagline/.test(role)) return Math.max(11, Math.round(height * .8));
  if (/title|heading/.test(role)) return Math.max(14, Math.min(48, Math.round(height * .9)));
  return Math.max(11, Math.min(28, Math.round(height * .85)));
}
function position(item:Entry, rootRegion = false): React.CSSProperties {
  const [x,y,w,h] = item.bounds || [0,0,1,1];
  const parent = !rootRegion && item.parentId ? byId.get(item.parentId) : undefined;
  const [px,py] = parent?.bounds || [0,0];
  const style = item.style || {};
  return { left:x-px, top:y-py, width:w, height:h,
    color: typeof item.style?.color === 'string' ? item.style.color : undefined,
    background: typeof item.style?.background === 'string' ? item.style.background : undefined,
    fontSize: item.kind === 'text' || item.kind === 'control' ?
      (typeof item.style?.fontSize === 'number' ? item.style.fontSize : inferredSize(item)) : undefined,
    fontFamily: typeof style.fontFamily === 'string' ? style.fontFamily :
      /high.contrast.serif/i.test(String(style.font || '')) ? 'Bodoni Moda, Georgia, serif' :
      /serif/i.test(String(style.font || '')) ? 'Georgia, serif' : undefined,
    fontWeight: typeof style.fontWeight === 'number' || typeof style.fontWeight === 'string' ? style.fontWeight as React.CSSProperties['fontWeight'] : undefined,
    lineHeight: typeof style.lineHeight === 'number' ? (style.lineHeight > 3 ? style.lineHeight + 'px' : style.lineHeight) :
      typeof style.lineHeight === 'string' ? style.lineHeight : undefined,
    letterSpacing: typeof style.letterSpacing === 'number' || typeof style.letterSpacing === 'string' ? style.letterSpacing : undefined,
    whiteSpace: item.text?.includes(String.fromCharCode(10)) ? 'pre-wrap' :
      /paragraph|body|description|intro|copy/.test((item.role || '').toLowerCase()) ? 'pre-wrap' : 'nowrap',
    display: item.kind === 'control' && /navigation item|navigation link|sidebar button/.test((item.role || '').toLowerCase()) ? 'flex' : undefined,
    alignItems: item.kind === 'control' && /navigation item|navigation link|sidebar button/.test((item.role || '').toLowerCase()) ? 'center' : undefined,
    textAlign: typeof item.style?.textAlign === 'string' ? item.style.textAlign as React.CSSProperties['textAlign'] : undefined,
    border: typeof style.border === 'string' ? style.border : undefined,
    borderBottom: typeof style.borderBottom === 'string' ? style.borderBottom : undefined,
    borderRadius: typeof style.borderRadius === 'number' || typeof style.borderRadius === 'string' ? style.borderRadius : undefined,
    padding: typeof style.padding === 'number' || typeof style.padding === 'string' ? style.padding :
      item.kind === 'control' && /input|textarea|select|field/.test((item.role || '').toLowerCase()) ?
        (/search/.test((item.role || '').toLowerCase()) ? '0 7px' : w > 300 ? '0 18px' : '0 10px') : undefined,
    objectFit: typeof style.objectFit === 'string' ? style.objectFit as React.CSSProperties['objectFit'] : undefined,
    opacity: typeof style.opacity === 'number' ? style.opacity : undefined,
    zIndex: typeof style.zIndex === 'number' ? style.zIndex : undefined };
}
function childrenOf(parent:Entry) {
  return entries.filter(item => item.parentId === parent.id ||
    (parent.kind === 'region' && item.ownerRegionId === parent.id && !byId.has(item.parentId || '')));
}
function Element({item}:{item:Entry}):React.ReactNode {
  const children = childrenOf(item).map(child => <Element key={child.id} item={child}/>);
  const controlClass = item.kind === 'control' ? /button|cta|pill/i.test(item.role) ? ' button' :
    /input|field|textarea|select|dropdown/i.test(item.role) ? ' field' : ' link' : '';
  const props = { className:'element '+item.kind+controlClass, style:position(item), 'data-i2c-id':item.id, 'data-role':item.role };
  const src = item.assetId ? assets[item.assetId] : null;
  if ((item.kind === 'media' || item.kind === 'icon') && src) return <img {...props} src={src} alt={item.role || ''}/>;
  if (item.kind === 'control') {
    if (/textarea|message field|multiline/i.test(item.role)) return <textarea {...props} aria-label={item.role} placeholder={item.text}/>;
    if (/select|dropdown/i.test(item.role)) return <select {...props} aria-label={item.role}><option>{item.text}</option></select>;
    if (/input|text field|email field|name field/i.test(item.role)) return <input {...props} aria-label={item.role}
      type={/email/i.test(item.role) ? 'email' : 'text'} placeholder={item.text}/>;
    return /button|cta|pill/i.test(item.role)
      ? <button {...props} type="button">{item.text}</button>
      : <a {...props} href="#">{item.text}</a>;
  }
  if (item.kind === 'text') return /headline|heading|title/i.test(item.role)
    ? /hero headline|main heading/i.test(item.role) ? <h1 {...props}>{item.text}</h1> : <h2 {...props}>{item.text}</h2>
    : <p {...props}>{item.text}</p>;
  return <div {...props}>{children}</div>;
}
function App() {
  React.useEffect(() => { void document.fonts.ready.then(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;
    for (const item of entries) {
      if (item.kind !== 'text' || !item.bounds || !item.text ||
        /paragraph|body|description|intro|copy/.test(item.role.toLowerCase())) continue;
      const node = document.querySelector<HTMLElement>('[data-i2c-id="' + CSS.escape(item.id) + '"]');
      if (!node) continue;
      const css = getComputedStyle(node);
      const size = parseFloat(css.fontSize);
      context.font = css.fontWeight + ' ' + size + 'px ' + css.fontFamily;
      const spacing = parseFloat(css.letterSpacing) || 0;
      const width = Math.max(...item.text.split(String.fromCharCode(10)).map(line =>
        context.measureText(line).width + Math.max(0, line.length - 1) * spacing));
      const target = item.bounds[2];
      if (width > target * 1.02) node.style.fontSize = Math.max(10, Math.round(10 * size * target / width) / 10) + 'px';
    }
  }); }, []);
  return <main className="page" style={{width:page.viewport.width,minHeight:page.viewport.height,
  background:page.theme.background,fontFamily:page.theme.fontFamily}}>
  {regions.map(region => <section key={region.id} className="region" data-i2c-id={region.id}
    data-role={region.role} style={position(region,true)}>{childrenOf({...region,kind:'region'}).map(item => <Element key={item.id} item={item}/>)}</section>)}
</main>; }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
`;
  const css = `@font-face{font-family:'Bodoni Moda';src:url('./fonts/bodoni-moda-400.woff2') format('woff2');font-weight:400;font-display:swap}@font-face{font-family:'Bodoni Moda';src:url('./fonts/bodoni-moda-700.woff2') format('woff2');font-weight:700;font-display:swap}*{box-sizing:border-box}html,body,#root{margin:0;min-height:100%}body{background:#fff;color:#222;font-family:Arial,Helvetica,sans-serif}.page{position:relative;max-width:100%;overflow:hidden}.region,.element{position:absolute}.region{overflow:visible}.element{margin:0}.text{white-space:pre-wrap;line-height:normal}.control{color:inherit;text-decoration:none;cursor:pointer;font-family:inherit}.control.button,.control.field{display:flex;align-items:center;justify-content:center;border:0;border-radius:0;background:transparent;padding:0}.control.link{background:transparent}.media{object-fit:cover}.media:not(img),.icon:not(img){background:rgba(120,110,100,.10)}
@media(max-width:700px){.page{width:100%!important;min-height:0!important;overflow:visible}.region{position:relative!important;left:auto!important;top:auto!important;width:100%!important;height:auto!important;min-height:160px;padding:24px;overflow:visible}.element:not(.media){position:relative!important;left:auto!important;top:auto!important;display:block;width:auto!important;height:auto!important;margin:0 0 16px}.media{position:relative!important;left:auto!important;top:auto!important;width:100%!important;height:auto!important;min-height:180px}.region:has(>.media:first-child)>.media:first-child{position:absolute!important;inset:0;width:100%!important;height:100%!important;z-index:-1}}
`;
  await fs.writeFile(path.join(site, 'src', 'main.tsx'), main);
  await fs.writeFile(path.join(site, 'src', 'style.css'), css);
  return { siteDir: site, entry: path.join(site, 'src', 'main.tsx'), pendingAssets: (inventory.assets || []).filter(asset => !assetMap[asset.id]).map(asset => asset.id) };
}

/** Compile the same React source after each edit, without changing the bound URL. */
export async function buildReactSite(siteDir) {
  const site = path.resolve(siteDir);
  if (!await exists(path.join(site, '.image-to-code-generated'))) throw new Error('This is not a generated React site.');
  if (!await exists(path.join(site, 'node_modules'))) {
    const cachedModules = path.join(template, 'node_modules');
    if (!await exists(cachedModules)) {
      if (process.platform === 'win32')
        await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ci --no-audit --no-fund'], template);
      else await run('npm', ['ci', '--no-audit', '--no-fund'], template);
    }
    await fs.symlink(cachedModules, path.join(site, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  await run(process.execPath, [path.join(site, 'node_modules', 'typescript', 'bin', 'tsc'), '-b'], site);
  await run(process.execPath, [path.join(site, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--base', './'], site);
  return { html: path.join(site, 'dist', 'index.html'), siteDir: site };
}
