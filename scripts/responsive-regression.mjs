import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { requireDependency } from '../src/common.mjs';
import { responsiveStarterCss } from '../src/responsive-starter.mjs';
import { inspectUsability } from '../src/page-check.mjs';
import { fitInPage } from '../src/fit.mjs';
import { reconcileFacts, applyReview } from '../src/review.mjs';
import { fastBudget, fixList } from '../src/fast.mjs';

const { chromium } = requireDependency('playwright');
const sharp = requireDependency('sharp');
const out = path.resolve('benchmarks/responsive-regression', new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' } : {}) });
const results = [];
const shell = body => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${responsiveStarterCss}
body{font:16px Arial;color:#222}.page{padding:20px}h1{font-size:30px}button,input{padding:10px}input{max-width:100%}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:20px}.card{padding:20px;background:#eee}
.split{display:grid;grid-template-columns:200px minmax(0,1fr);gap:24px}.split>*{min-width:0}.scroll{overflow:auto}td{padding:12px}table{min-width:700px}
@media(max-width:600px){.split{grid-template-columns:1fr}}
</style></head><body><main class="page">${body}</main></body></html>`;
const cases = [
  ['commerce', '<h1 data-i2c-id="T1">Independent products</h1><div class="grid">'+[1,2,3,4].map(i=>`<article class="card"><h2>Product ${i}</h2><p>Details wrap naturally within this card.</p><button>Add item</button></article>`).join('')+'</div>'],
  ['dashboard', '<div class="split"><aside>Workspace navigation</aside><section><h1 data-i2c-id="T1">Activity dashboard</h1><div class="scroll"><table><tr><td>Account</td><td>Month</td><td>Status</td><td>Revenue</td></tr></table></div></section></div>'],
  ['documentation', '<div class="split"><nav>Contents</nav><article><h1 data-i2c-id="T1">Documentation guide</h1><p>'+('A readable paragraph that wraps with its container. '.repeat(16))+'</p></article></div>'],
  ['form', '<h1 data-i2c-id="T1">Account settings</h1><form><label>Email <input data-i2c-id="T2" type="email" placeholder="Email address"></label><button>Save settings</button></form>'],
  ['photo-overlay', '<section style="position:relative;min-height:300px;background:#333;color:white;padding:24px"><h1 data-i2c-id="T1">A layered scene</h1><p>Text stays inside its intentional background container.</p></section>'],
  ['rtl-content', '<article dir="rtl"><h1 data-i2c-id="T1">مرحبا بكم</h1><p>هذا نص عربي لاختبار التخطيط واتجاه القراءة.</p><label>البريد الإلكتروني <input type="email"></label></article>'],
  ['portfolio', '<h1 data-i2c-id="T1">Selected work</h1><div class="grid"><article style="background:#def;padding:24px;min-height:240px"><h2>Project one</h2><p>Asymmetric editorial composition</p></article><article style="padding-top:60px"><h2>Project two</h2><p>Independent content remains readable.</p></article></div>'],
];
try {
  for (const [name, body] of cases) for (const width of [1280,768,390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(shell(body));
    const result = await inspectUsability(page, { expected: name === 'form' ? [{ id:'T2', text:'Email address' }] : [] });
    assert.equal(result.issues.filter(i=>i.severity==='error').length,0,`${name}/${width}: ${JSON.stringify(result.issues)}`);
    results.push({ name, width, errors: 0 });
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width:390,height:900 } });
  await page.setContent(shell('<div style="width:1024px"><h1>Fixed-width failure</h1></div>'));
  assert.ok((await inspectUsability(page)).issues.some(i=>i.kind==='overflow'));
  await page.setContent(shell('<h1 data-i2c-id="T1">Visible heading</h1><div id="cover" style="position:absolute;inset:0;height:200px;background:black;z-index:5"></div>'));
  assert.ok((await inspectUsability(page)).issues.some(i=>i.kind==='covered-content' && i.id==='T1'));
  await page.setContent(shell('<div style="height:20px;overflow:hidden"><p data-i2c-id="T1" style="margin-top:50px">Clipped heading</p></div>'));
  assert.ok((await inspectUsability(page)).issues.some(i=>i.kind==='clipped-content'));
  await page.setContent(shell('<p data-i2c-id="T1">Wrong wording</p>'));
  assert.ok((await inspectUsability(page,{expected:[{id:'T1',text:'Required wording'}]})).issues.some(i=>i.kind==='missing-content'));
  await page.setContent(shell('<input data-i2c-id="T1" placeholder="Email address"><p data-i2c-id="T2" style="font-size:38px">Measured words</p>'));
  const before = await page.content();
  const fit = await page.evaluate(fitInPage, { adjust:false, allBoxes:[], others:[], texts:[
    {id:'T1',lines:[{text:'Email address',box:[0,0,100,20],baseline:20}]},
    {id:'T2',size:12,lines:[{text:'Measured words',box:[0,0,70,12],baseline:32}]}
  ] });
  assert.equal(fit.overrides.length,0);
  assert.ok(!fit.missing.includes('T1'));
  assert.equal(await page.content(),before,'Observation must not change markup/styles when no font probes are requested.');
  await page.close();

  const raw = { viewport:{width:300,height:200}, sections:[{id:'S1',y:0,height:200,items:[
    {id:'T1',type:'text',box:[10,10,120,20],family:'Arial',lines:[{text:'Bad OCR',box:[10,10,120,20],baseline:28}]},
    {id:'I1',type:'image',box:[0,60,300,100],file:'assets/I1.png'}
  ]}]};
  const plan = {version:1,containers:[{id:'content',role:'content',items:['T1','I1'],layout:'Shared container with independent media.',responsive:'Stack and wrap.'}],corrections:[{id:'T1',text:'Correct wording',reason:'Visible in source.'}],assets:[]};
  const reviewed = reconcileFacts(raw,plan);
  assert.equal(reviewed.sections[0].items[0].geometryTrusted,false);
  assert.equal(raw.sections[0].items[0].reviewedText,undefined);
  assert.throws(()=>reconcileFacts(raw,{...plan,containers:[{...plan.containers[0],items:['BAD']}]}));
  const work=path.join(out,'work'),site=path.join(out,'site');
  await fs.mkdir(path.join(work,'assets'),{recursive:true}); await fs.mkdir(path.join(site,'public','assets'),{recursive:true});
  const screenshot=path.join(out,'image.png');
  await sharp({create:{width:300,height:200,channels:3,background:'#123456'}}).png().toFile(screenshot);
  await fs.writeFile(path.join(work,'facts.json'),JSON.stringify(raw));
  await fs.writeFile(path.join(work,'page-inventory.json'),JSON.stringify({elements:[],assets:[]}));
  const planFile=path.join(out,'plan.json');
  await fs.writeFile(planFile,JSON.stringify({...plan,assets:[{id:'independent',decision:'crop',box:[20,70,80,60],replaces:['I1'],reason:'One clean image'}]}));
  await applyReview({state:{work,site,screenshot},planFile});
  assert.equal((await sharp(path.join(site,'public/assets/independent.png')).metadata()).width,80);
  await fs.writeFile(planFile,JSON.stringify({...plan,assets:[{id:'unsafe',decision:'crop',box:[0,0,180,50],reason:'Intersects text'}]}));
  await assert.rejects(()=>applyReview({state:{work,site,screenshot},planFile}),/overlaps live text/);

  const pFacts={viewport:{width:1000},sections:[{id:'S',items:[1,2,3].map(n=>({id:`T${n}`,type:'text',lines:[{box:[0,0,20,10],baseline:10}]}))}]};
  const fixes=fixList({facts:pFacts,report:{pageHealth:{}},fit:{missing:[],stray:[],families:[],wraps:[],positions:[1,2,3].map(n=>({id:`T${n}`,dx:0,dy:500}))}});
  assert.equal(fixes.length,1,'A shared ancestor shift should be one grouped repair.');
  assert.ok(fastBudget({startedAt:'2026-01-01T00:00:00Z',maxMinutes:10},Date.parse('2026-01-01T00:11:00Z')).exhausted);
  await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({cases:results,checks:['overflow','occlusion','clipping','missing wording','input placeholder','non-mutating observation','review correction','clean asset crop','text-overlap rejection','grouped offsets','deadline'],passed:true},null,2));
  console.log(`Passed: ${results.length} healthy layout/viewport cases and 11 failure/contract checks. Evidence: ${out}`);
} finally { await browser.close(); }
