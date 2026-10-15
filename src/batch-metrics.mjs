import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireDependency } from './common.mjs';
import { fontLibrary } from './facts.mjs';
const { chromium } = requireDependency('playwright');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

export async function ensureReviewedFonts(facts, work, site) {
  const library = await fontLibrary(), faces = new Map();
  for (const item of facts.sections.flatMap(s => s.items).filter(i => i.type === 'text')) {
    const face = library.find(f => f.name.toLowerCase() === item.family?.toLowerCase() || f.id === item.familyId && !item.familyReviewed);
    if (!face) continue;
    item.familyId = face.id;
    const requested = Number(item.weight) || 400;
    item.weight = face.weights.reduce((a,b) => Math.abs(b-requested)<Math.abs(a-requested)?b:a);
    faces.set(`${face.id}-${item.weight}`, {face,weight:item.weight});
  }
  if (!faces.size) return;
  await fs.mkdir(path.join(work,'fonts'),{recursive:true});
  await fs.mkdir(path.join(site,'src/fonts'),{recursive:true});
  const css = [];
  for (const [id,{face,weight}] of faces) {
    const filename = `${id}.woff2`;
    await fs.copyFile(face.file(weight),path.join(work,'fonts',filename));
    await fs.copyFile(face.file(weight),path.join(site,'src/fonts',filename));
    css.push(`@font-face{font-family:'${face.name}';src:url('./fonts/${filename}') format('woff2');font-weight:${weight};font-style:normal;font-display:block}`);
  }
  await fs.writeFile(path.join(work,'fonts.css'),css.join('\n'));
  await fs.writeFile(path.join(site,'src/fonts.css'),css.join('\n'));
}

// One browser and a persistent per-job cache replace agent-authored canvas probes.
export async function measureFontBatch({ work, facts, jobs }) {
  work = path.resolve(work);
  const library = await fontLibrary();
  const source = jobs || facts.sections.flatMap(s => s.items).filter(i => i.type === 'text').flatMap(i => {
    const text = i.reviewedText || i.lines?.map(l => l.text).join('\n') || '';
    return [...new Set([i.family,...(i.fontCandidates || []).slice(0,2).map(c => c.family)])].filter(Boolean)
      .map(family => ({id:i.id,text,family,weight:i.weight || 400,size:i.size || 16,
        targetWidth:i.geometryTrusted !== false ? Math.max(...(i.lines || []).map(l=>l.box[2]),i.box?.[2] || 0) : null}));
  });
  if (!Array.isArray(source) || source.length > 2000) throw new Error('Font batch must be an array of at most 2000 jobs.');
  const cacheFile = path.join(work,'font-metrics-cache.json');
  const cache = await fs.readFile(cacheFile,'utf8').then(JSON.parse).catch(()=>({}));
  const pending = [], results = [], faces = new Map();
  for (const job of source) {
    if (!job.id || typeof job.text !== 'string' || !job.text.trim() || !Number.isFinite(Number(job.size)) || Number(job.size)<=0) throw new Error('Each font job needs id, text, family and positive size.');
    const face = library.find(f => f.name.toLowerCase() === job.family?.toLowerCase() || f.id === job.family);
    if (!face) {results.push({...job,status:'unavailable',note:'Font not in the bundled library; no silent substitution.'}); continue;}
    const weight = face.weights.reduce((a,b)=>Math.abs(b-(job.weight || 400))<Math.abs(a-(job.weight || 400))?b:a);
    const faceId = `${face.id}-${weight}`;
    if (!faces.has(faceId)) {const bytes=await fs.readFile(face.file(weight));faces.set(faceId,{id:faceId,source:bytes.toString('base64'),sha:hash(bytes)});}
    const normalized = {...job,size:Number(job.size),family:face.name,weight};
    const key=hash(JSON.stringify({job:normalized,font:faces.get(faceId).sha,version:1}));
    if (cache[key]) results.push({...cache[key],cached:true}); else pending.push({key,faceId,job:normalized});
  }
  if (pending.length) {
    const requested=process.env.CHROME_PATH || (process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':null);
    const executablePath=requested && await fs.access(requested).then(()=>requested).catch(()=>undefined);
    const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
    try {
      const page=await browser.newPage();
      const values=await page.evaluate(async ({faces,pending})=>{
        for (const f of faces) {const font=new FontFace(f.id,`url(data:font/woff2;base64,${f.source})`);await font.load();document.fonts.add(font);}
        const ctx=document.createElement('canvas').getContext('2d');
        return pending.map(({key,faceId,job})=>{
          ctx.font=`${job.size}px "${faceId}"`;
          const lines=job.text.split(/\r?\n/).map(text=>{const m=ctx.measureText(text);return {text,advance:m.width,inkWidth:m.actualBoundingBoxLeft+m.actualBoundingBoxRight,ascent:m.actualBoundingBoxAscent,descent:m.actualBoundingBoxDescent};});
          const widest=Math.max(...lines.map(l=>l.inkWidth));
          return {key,result:{...job,lines,status:'measured',estimatedSizeForWidth:job.targetWidth && widest ? job.size*job.targetWidth/widest:null,
            note:'Metrics describe this candidate font. Matching width does not prove identity or CSS box dimensions.'}};
        });
      },{faces:[...faces.values()],pending});
      for (const {key,result} of values) {cache[key]=result;results.push({...result,cached:false});}
    } finally {await browser.close();}
  }
  const report={version:1,jobs:results,computed:pending.length,cached:results.filter(r=>r.cached).length};
  await fs.writeFile(cacheFile,JSON.stringify(cache));
  await fs.writeFile(path.join(work,'font-measurements.json'),JSON.stringify(report,null,2));
  return {file:path.join(work,'font-measurements.json'),computed:report.computed,cached:report.cached,unavailable:results.filter(r=>r.status==='unavailable').length};
}
