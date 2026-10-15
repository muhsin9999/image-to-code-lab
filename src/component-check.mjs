export function validateConstraints(c) {
  const k = c.constraints;
  if (!k) return;
  if (typeof k !== 'object' || Array.isArray(k)) throw new Error(`Invalid constraints for ${c.id}.`);
  if (k.bounds && (!Array.isArray(k.bounds) || k.bounds.length !== 4 || !k.bounds.every(Number.isFinite) || k.bounds[2] <= 0 || k.bounds[3] <= 0)) throw new Error(`Invalid container bounds for ${c.id}.`);
  for (const key of ['columns', 'gap', 'maxWidth', 'aspectRatio', 'tolerance']) if (k[key] !== undefined && (!Number.isFinite(k[key]) || k[key] < 0)) throw new Error(`Invalid ${key} for ${c.id}.`);
  if (k.padding && (!Array.isArray(k.padding) || k.padding.length !== 4 || !k.padding.every(n => Number.isFinite(n) && n >= 0))) throw new Error(`Invalid padding for ${c.id}.`);
  if (k.atWidths && (!Array.isArray(k.atWidths) || k.atWidths.some(w => !Number.isInteger(w) || w < 240 || w > 3840))) throw new Error(`Invalid atWidths for ${c.id}.`);
}

export async function inspectComponents(page, facts) {
  return page.evaluate(({ containers, referenceWidth }) => {
    const rows = [], issues = [];
    for (const c of containers) {
      const selector = c.selector || `[data-i2c-container="${CSS.escape(c.id)}"]`;
      let el;
      try { el = document.querySelector(selector); } catch { issues.push({ kind: 'container-selector', id:c.id, severity:'error', message:`Invalid selector ${selector}` }); continue; }
      if (!el) { issues.push({kind:'container-unmapped',id:c.id,severity:'warning',message:`Map the ${c.id} component with ${selector} to check its layout.`}); continue; }
      const b = el.getBoundingClientRect(), s = getComputedStyle(el), k = c.constraints || {};
      if (!b.width || !b.height) continue;
      const actual = { bounds:[b.x+scrollX,b.y+scrollY,b.width,b.height], padding:['Top','Right','Bottom','Left'].map(v=>parseFloat(s[`padding${v}`])), gap:parseFloat(s.columnGap)||0,
        columns:s.display==='grid' ? s.gridTemplateColumns.split(/\s+/).length : null, aspectRatio:b.width/b.height };
      const applicable = k.atWidths ? k.atWidths.includes(innerWidth) : innerWidth === referenceWidth;
      const deltas = {};
      const compare = (key, target, measured, tolerance=k.tolerance ?? 6) => {
        const a=Array.isArray(target)?target:[target], v=Array.isArray(measured)?measured:[measured];
        const d=a.map((n,i)=>v[i]-n); deltas[key]=d;
        if(d.some(n=>!Number.isFinite(n)||Math.abs(n)>tolerance)) issues.push({kind:'container-geometry',id:c.id,severity:'warning',message:`${c.id} ${key}: expected ${a.join(', ')}, rendered ${v.map(n=>Number(n).toFixed(1)).join(', ')}. Fix the shared container before child offsets.`});
      };
      if(applicable) {
        if(k.bounds) compare('bounds',k.bounds,actual.bounds);
        if(k.padding) compare('padding',k.padding,actual.padding);
        if(k.gap!==undefined) compare('gap',k.gap,actual.gap);
        if(k.columns!==undefined) compare('columns',k.columns,actual.columns,0);
        if(k.aspectRatio!==undefined) compare('aspectRatio',k.aspectRatio,actual.aspectRatio,.04);
        if(k.maxWidth!==undefined && b.width>k.maxWidth+(k.tolerance??6)) compare('maxWidth',k.maxWidth,b.width);
      }
      if(c.parentId) {
        const parent=containers.find(p=>p.id===c.parentId);
        let node;try {node=document.querySelector(parent.selector || `[data-i2c-container="${CSS.escape(parent.id)}"]`);}catch{}
        if(node && !node.contains(el)) issues.push({kind:'container-ownership',id:c.id,severity:'warning',message:`${c.id} is outside its reviewed parent ${c.parentId}.`});
      }
      rows.push({id:c.id,selector,expected:k,actual,deltas,applicable});
    }
    return {rows,issues};
  },{containers:facts.review?.containers||[],referenceWidth:facts.viewport.width});
}

// Only test local disclosure controls with explicit accessibility contracts.
// Unlabelled menu-like buttons are reported as unverified, never guessed-clicked.
export async function inspectDisclosures(page) {
  const issues=[], tested=[];
  const buttons=page.locator('button[aria-expanded],button[aria-controls]');
  for(let n=0;n<await buttons.count();n++) {
    const button=buttons.nth(n);
    if(!await button.isVisible()) continue;
    const id=await button.getAttribute('aria-controls'), name=(await button.textContent() || await button.getAttribute('aria-label') || 'disclosure').trim();
    if(!id) {issues.push({kind:'interaction-unverified',id:name,severity:'warning',message:'Disclosure has no aria-controls target; declare and test its behavior.'});continue;}
    const target=page.locator(`[id=${JSON.stringify(id)}]`);
    try {
      if(await target.count()!==1) throw new Error('aria-controls must reference one existing element.');
      const before=await button.getAttribute('aria-expanded'), visibleBefore=await target.isVisible();
      await button.click({timeout:1500});
      await page.waitForFunction(({id,before})=>document.querySelector(`[aria-controls="${CSS.escape(id)}"]`)?.getAttribute('aria-expanded')!==before,{id,before},{timeout:1500});
      const after=await button.getAttribute('aria-expanded'), visibleAfter=await target.isVisible();
      if(!['true','false'].includes(after) || visibleBefore===visibleAfter || visibleAfter!==(after==='true')) throw new Error('Disclosure state and controlled content visibility did not toggle together.');
      await button.click({timeout:1500});
      await page.waitForFunction(({id,before})=>document.querySelector(`[aria-controls="${CSS.escape(id)}"]`)?.getAttribute('aria-expanded')===before,{id,before},{timeout:1500});
      if(await target.isVisible()!==visibleBefore) throw new Error('Disclosure did not restore its original visibility.');
      tested.push({id,status:'passed'});
    } catch(error) {issues.push({kind:'interaction-failed',id:name,severity:'error',message:error.message});tested.push({id,status:'failed'});}
  }
  const undeclared=await page.locator('button:not([aria-controls])').evaluateAll(nodes=>nodes.filter(e=>e.getClientRects().length && /menu|navigation/i.test(`${e.textContent} ${e.getAttribute('aria-label')} ${e.className}`)).map(e=>e.getAttribute('aria-label')||e.textContent||e.className));
  for(const id of undeclared) issues.push({kind:'interaction-unverified',id,severity:'warning',message:'Visible menu control lacks a controlled target. Add an accessible menu and a behavioral expectation.'});
  return {tested,issues};
}
