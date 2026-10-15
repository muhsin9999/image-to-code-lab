import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { reconcileFacts } from '../src/review.mjs';
import { fastReview, fastTiming } from '../src/fast.mjs';
import { measureFontBatch } from '../src/batch-metrics.mjs';
import { summarizeIntervals, timingDirectory } from '../src/timing.mjs';
import { checkViewports } from '../src/page-check.mjs';
import { requireDependency } from '../src/common.mjs';
const sharp=requireDependency('sharp');
const out=path.resolve('benchmarks/brief-workflow-regression',new Date().toISOString().replace(/[:.]/g,'-'));
const work=path.join(out,'work'),site=path.join(out,'site');
await fs.mkdir(path.join(work,'assets'),{recursive:true});await fs.mkdir(path.join(site,'src'),{recursive:true});
const raw={viewport:{width:1000,height:600},sections:[{id:'S1',y:0,height:600,items:[
  {id:'T1',type:'text',box:[20,20,170,25],family:'Arimo',weight:400,size:20,lines:[{text:'Visible title',box:[20,20,170,25],baseline:42}],role:'heading'},
  {id:'U1',type:'unread',box:[20,60,180,20],textLike:'T1'},
  {id:'K1',type:'icon',box:[20,90,30,15],file:'icons/K1.png',textLike:'T1'},
  {id:'T2',type:'text',box:[20,120,50,20],family:'Arimo',size:16,lines:[{text:'Hello',box:[20,120,50,20],baseline:138}]},
  {id:'T3',type:'text',box:[80,120,50,20],family:'Arimo',size:16,lines:[{text:'world',box:[80,120,50,20],baseline:138}]},
  {id:'I1',type:'image',box:[0,200,1000,400],behindText:true,file:null}
]}]};
const plan={version:1,containers:[{id:'content',role:'Content',items:['T1','U1','K1','T2','T3','I1'],layout:'Shared left alignment in document flow',responsive:'Wrap content'}],
  corrections:[{id:'U1',text:'Previously unread copy',reason:'Visible wording'},{id:'K1',text:'£28',reason:'Price, not icon'},{id:'T2',text:'Hello world',replaces:['T3'],reason:'One phrase'}],assets:[]};
const reviewed=reconcileFacts(raw,plan),items=reviewed.sections[0].items;
assert.equal(items.find(i=>i.id==='U1').type,'text');assert.equal(items.find(i=>i.id==='K1').file,undefined);
assert.equal(items.find(i=>i.id==='K1').family,'Arimo');assert.ok(!items.some(i=>i.id==='T3'));
assert.equal(raw.sections[0].items.find(i=>i.id==='K1').type,'icon');
const split=reconcileFacts(raw,{...plan,additions:[{id:'new1',type:'text',text:'First',box:[20,20,50,25],styleLike:'T1',replaces:['T1'],reason:'Separate label'},{id:'new2',type:'text',text:'Second',box:[90,20,70,25],styleLike:'T1',replaces:['T1'],reason:'Separate label'}]});
assert.ok(split.sections[0].items.some(i=>i.id==='new2'));assert.ok(!split.sections[0].items.some(i=>i.id==='T1'));
assert.throws(()=>reconcileFacts(raw,{...plan,containers:[{...plan.containers[0],parentId:'content'}]}),/cyclic/);
const screenshot=path.join(out,'target.png');await sharp({create:{width:1000,height:600,channels:3,background:'#ddd'}}).png().toFile(screenshot);
const state={version:4,work,site,screenshot,startedAt:new Date(Date.now()-15*60000).toISOString(),maxMinutes:10,maxRuns:3,runs:path.join(work,'runs')};
await fs.writeFile(path.join(work,'fast.json'),JSON.stringify(state));await fs.writeFile(path.join(work,'facts.json'),JSON.stringify(raw));
await fs.writeFile(path.join(work,'page-inventory.json'),JSON.stringify({elements:[],assets:[],regions:[]}));
const planFile=path.join(out,'plan.json');await fs.writeFile(planFile,JSON.stringify(plan));
const applied=await fastReview({out:work,plan:planFile});assert.ok(applied.budget.exhausted);
const accepted=await fs.readFile(path.join(work,'reviewed-facts.json'),'utf8');
const brief=JSON.parse(await fs.readFile(path.join(work,'design-brief.json'),'utf8'));
assert.equal(brief.status,'visually-reviewed');assert.equal(brief.elements.find(i=>i.id==='K1').text,'£28');
const inv=JSON.parse(await fs.readFile(path.join(work,'reviewed-inventory.json'),'utf8'));assert.equal(inv.elements.find(i=>i.id==='K1').kind,'text');
await fs.writeFile(planFile,JSON.stringify({...plan,assets:[{id:'fragment',decision:'crop',box:[400,220,200,100],replaces:['I1'],reason:'Partial scene'}]}));
await assert.rejects(()=>fastReview({out:work,plan:planFile}),/fragment/);
assert.equal(await fs.readFile(path.join(work,'reviewed-facts.json'),'utf8'),accepted);
assert.ok(await fs.readFile(path.join(work,'review-errors.json'),'utf8'));
raw.supplied=[{path:'assets/original.png',width:1000,height:600}];
await fs.copyFile(screenshot,path.join(work,'assets/original.png'));
await fs.writeFile(path.join(work,'facts.json'),JSON.stringify(raw));
await fs.writeFile(planFile,JSON.stringify({...plan,corrections:[...plan.corrections,{id:'T1',family:'Merriweather',reason:'Reviewed serif heading'}],assets:[{id:'scene',decision:'reuse',sourceId:'assets/original.png',box:[0,200,1000,400],replaces:['I1'],reason:'Supplied full scene'}]}));
await fastReview({out:work,plan:planFile});
assert.equal((await sharp(path.join(site,'public/assets/scene.png')).metadata()).width,1000);
assert.ok((await fs.readFile(path.join(site,'src/fonts.css'),'utf8')).includes('Merriweather'));
const jobs=[{id:'sample',text:'Independent batch',family:'Arimo',size:20,weight:400,targetWidth:150}];
await fs.writeFile(planFile,JSON.stringify({...plan,assets:[{id:'autoScene',decision:'placeholder',box:[0,200,1000,400],reason:'Original unavailable; same full region'}]}));
await fastReview({out:work,plan:planFile});
const autoFacts=JSON.parse(await fs.readFile(path.join(work,'reviewed-facts.json'),'utf8'));
assert.ok(!autoFacts.sections.flatMap(s=>s.items).some(i=>i.id==='I1'));
assert.deepEqual(autoFacts.review.containers[0].items.filter(id=>id==='autoScene'),['autoScene']);
assert.equal(JSON.parse(await fs.readFile(path.join(work,'asset-audit.json'),'utf8')).unresolved.length,1);
const first=await measureFontBatch({work,jobs}),second=await measureFontBatch({work,jobs});assert.equal(first.computed,1);assert.equal(second.computed,0);assert.equal(second.cached,1);
const stats=summarizeIntervals([{command:'outer',startedAt:new Date(0).toISOString(),endedAt:new Date(100).toISOString(),durationMs:100},{command:'inner',startedAt:new Date(20).toISOString(),endedAt:new Date(70).toISOString(),durationMs:50}],0,150);
assert.equal(stats.trackedMs,100);assert.equal(stats.untrackedMs,50);
const cli=path.resolve('bin/image-to-code.mjs');
const run=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[cli,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('error',reject);child.on('exit',code=>resolve({code,output}));});
const jobFile=path.join(out,'command.json');
await fs.writeFile(jobFile,JSON.stringify({program:'node',args:['-e','process.exit(7)'],label:'deliberate failure',reason:'Verify failure telemetry'}));
assert.equal((await run(['fast','exec','--out',work,'--job',jobFile])).code,7);
const log=(await fs.readFile(path.join(work,'timing.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
assert.ok(log.some(e=>e.command==='fast exec' && e.status==='failed' && e.afterTarget));
assert.equal(await timingDirectory(['icons','search','--query','home'],out),work);
const timing=await fastTiming({out:work});assert.ok(timing.totalMinutes>=15);assert.equal(timing.failedCalls,1);
const html=path.join(out,'page.html');
await fs.writeFile(html,'<!doctype html><style>body{margin:0;font:16px Arial}#menu{display:none}@media(max-width:600px){main{padding:10px}}@media(min-width:601px){main{padding:20px}}</style><main><h1>Test page</h1><button id="toggle" onclick="document.querySelector(\'#menu\').style.display=\'block\'">Menu</button><div id="menu">Account menu</div><input id="email" placeholder="Email address"></main>');
const health=await checkViewports({html,runDir:out,facts:{viewport:{width:1000,height:600},sections:[],review:{breakpoints:[600],interactions:[{selector:'#toggle',action:'click',expect:{selector:'#menu',visible:true}},{selector:'#email',action:'fill',value:'hello@example.com',expect:{value:'hello@example.com'}}]}}});
assert.ok(health.some(h=>h.width===599));assert.ok(health.some(h=>h.width===601));
assert.ok(health.every(h=>h.interactions.tested.length===2 && h.interactions.tested.every(t=>t.status==='passed')));
await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({passed:true,checks:['unread/icon reclassification','style inheritance','merge','split','raw evidence preserved','parent cycle rejected','expired review accepted','generated brief and inventory','partial-background rejected','prior accepted review retained','supplied original reused','reviewed font copied','font cache reused','nested timing union','external failure and overrun logged','all-command timing routing','elapsed includes post-check work','breakpoint and interaction checks','unambiguous replacement retires old image and preserves container ownership'],widths:health.map(h=>h.width)},null,2));
console.log(`Brief workflow regression passed. Evidence: ${out}`);
