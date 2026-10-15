import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildFacts } from './facts.mjs';
import { buildReactSite } from './react-render.mjs';
import { fitPage } from './fit.mjs';
import { draftApp } from './draft.mjs';
import { responsiveStarterCss } from './responsive-starter.mjs';
import { applyReview, assetAudit } from './review.mjs';
import { checkViewports } from './page-check.mjs';
import { writeDesignBrief } from './design-brief.mjs';
import { measureFontBatch } from './batch-metrics.mjs';
import { summarizeIntervals } from './timing.mjs';

const template = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates/react-vite');
const exists = file => fs.access(file).then(() => true).catch(() => false);
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse);
const stateFile = out => path.join(path.resolve(out), 'fast.json');
const pct = v => `${(100 * v).toFixed(1)}%`;

// Vite alone (esbuild strips types); type errors never change the render, so skip tsc for speed.
async function viteBuild(site) {
  if (!await exists(path.join(site, 'node_modules'))) return buildReactSite(site);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(site, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--base', './', '--logLevel', 'error'],
      { cwd: site, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    child.on('error', reject);
    child.on('exit', code => code ? reject(new Error(output.slice(-1800))) : resolve());
  });
  return { html: path.join(site, 'dist', 'index.html'), siteDir: site };
}

export async function fastInit({ screenshot, out = 'work', site = 'site', assetsDir, maxRuns, maxMinutes = 10, draft = false, language = 'eng' }) {
  maxRuns = maxRuns ?? (draft ? 4 : 3);
  if (!Number.isInteger(Number(maxRuns)) || Number(maxRuns) < 1 || !Number.isFinite(Number(maxMinutes)) || Number(maxMinutes) <= 0) throw new Error('max-runs must be a positive integer and max-minutes must be positive.');
  const work = path.resolve(out), siteDir = path.resolve(site);
  if (await exists(stateFile(work))) throw new Error(`${work} already holds a fast run. Use a fresh --out folder.`);
  if (await exists(siteDir) && (await fs.readdir(siteDir)).some(e => e !== 'node_modules')) throw new Error(`${siteDir} is not empty. Use a fresh --site folder.`);
  const startedAt = new Date().toISOString();
  const result = await buildFacts({ screenshot, out: work, assetsDir, language });
  const facts = await readJson(path.join(work, 'facts.json'));

  await fs.mkdir(siteDir, { recursive: true });
  await fs.cp(template, siteDir, { recursive: true, filter: source => !source.split(path.sep).includes('node_modules') });
  await fs.writeFile(path.join(siteDir, '.image-to-code-generated'), 'Starter site for the fast image-to-code path.\n');
  await fs.cp(path.join(work, 'fonts'), path.join(siteDir, 'src', 'fonts'), { recursive: true });
  await fs.copyFile(path.join(work, 'fonts.css'), path.join(siteDir, 'src', 'fonts.css'));
  await fs.mkdir(path.join(siteDir, 'public'), { recursive: true });
  await fs.cp(path.join(work, 'assets'), path.join(siteDir, 'public', 'assets'), { recursive: true });
  await fs.cp(path.join(work, 'icons'), path.join(siteDir, 'public', 'icons'), { recursive: true });
  const { width, height } = facts.viewport;
  await fs.writeFile(path.join(siteDir, 'src', 'main.tsx'), `import React from 'react';
import { createRoot } from 'react-dom/client';
import './fonts.css';
import './style.css';
import './fit.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
`);
  const generated = draftApp(facts);
  await fs.writeFile(path.join(siteDir, 'src', 'App.tsx'), draft ? generated.app : `// Write the page here. Read ../work/facts.md first.
export function App() {
  return <main className="page"></main>;
}
`);
  await fs.writeFile(path.join(siteDir, 'src', 'style.css'), draft ? generated.css : responsiveStarterCss);
  await fs.writeFile(path.join(siteDir, 'src', 'fit.css'), '/* Reserved for compatibility. Automatic font overrides are disabled. */\n');
  await fs.writeFile(path.join(work, 'layout-plan.template.json'), JSON.stringify({ version: 1, containers: [], corrections: [], additions: [], assets: [], uncertainties: [], breakpoints: [], interactions: [] }, null, 2));
  await fs.writeFile(path.join(work, 'asset-audit.json'), JSON.stringify(assetAudit(facts), null, 2));
  const state = { version: 5, limitMode: 'observe', draft: Boolean(draft), startedAt, screenshot: path.resolve(screenshot), work, site: siteDir, maxRuns: Number(maxRuns), maxMinutes: Number(maxMinutes), runs: path.join(work, 'runs') };
  await fs.writeFile(stateFile(work), JSON.stringify(state, null, 2) + '\n');
  await writeDesignBrief({ work, facts });
  const batchMetrics = await measureFontBatch({ work, facts });
  // check 1 measures the generated draft, so the agent starts with a concrete fix list
  const first = draft ? await fastCheck({ out: work }) : null;
  return { ...result, site: siteDir, firstCheck: first, batchMetrics,
    next: draft ? `The draft in site/src/App.tsx was checked (above). Fix what the check lists and any wording marked PARTLY READ, then run: npm run tool -- fast check --out ${out}`
      : `Read design-brief.md with the screenshot. Correct uncertain classifications/fonts and specify component relationships in the short review plan. Run fast review --out ${out} --plan <plan.json>, then build. Time targets never disable tools.` };
}

export function fastBudget(state, now = Date.now()) {
  const elapsedMinutes = (now - Date.parse(state.startedAt)) / 60000;
  return { elapsedMinutes, maxMinutes: state.maxMinutes ?? null, exhausted: state.maxMinutes != null && elapsedMinutes >= state.maxMinutes,
    overTargetMinutes: state.maxMinutes == null ? 0 : Math.max(0, elapsedMinutes - state.maxMinutes), enforcement: 'observe' };
}

export async function fastReview({ out = 'work', plan }) {
  const state = await readJson(stateFile(out));
  let result;
  try { result = await applyReview({ state, planFile: plan }); }
  catch (error) {
    await fs.writeFile(path.join(state.work, 'review-errors.json'), JSON.stringify({ at: new Date().toISOString(), error: error.message, plan, priorAcceptedReview: state.review || null, next: 'Fix the named field and resubmit the plan. Prior accepted review files remain available.' }, null, 2));
    throw error;
  }
  state.review = { at: result.reviewedAt, hash: result.hash };
  await fs.writeFile(stateFile(out), JSON.stringify(state, null, 2));
  return { ...result, budget: fastBudget(state) };
}

export async function fastStatus({ out = 'work' }) {
  const state = await readJson(stateFile(out));
  const session = await readJson(path.join(state.runs, 'session.json')).catch(() => null);
  return { ...fastBudget(state), reviewComplete: Boolean(state.review), checksUsed: session?.runCount || 0, maxRuns: state.maxRuns,
    best: await readJson(path.join(state.work, 'best-check.json')).catch(() => null), comparisonOnly:session?.best || null };
}

export function fixList({ fit, report, facts }) {
  const items = facts.sections.flatMap(s => s.items);
  const byId = new Map(items.map(i => [i.id, i]));
  const fixes = [];
  for (const id of fit.missing.slice(0, 12)) {
    const text = byId.get(id)?.lines?.map(l => l.text).join(' / ') || '';
    fixes.push({ weight: 1000, text: `${id} not found: put data-i2c-id="${id}" on the element showing "${text.slice(0, 60)}" (add it if it is missing).` });
  }
  if (fit.missing.length > 12) fixes.push({ weight: 999, text: `${fit.missing.length - 12} more text ids are missing. Every T item in facts.md needs its data-i2c-id.` });
  for (const g of fit.stray) fixes.push({ weight: 950, text: `Review ${g.tag} at ${g.box.join(', ')}: no measured graphic matches this position. Check its parent layout and visual purpose.` });
  const className = { sans: 'sans-serif', serif: 'serif', mono: 'monospace' };
  for (const f of fit.families || []) fixes.push({ weight: 500, text: `${f.id}: rendered ${f.used} (${className[f.usedClass]}); extraction estimated ${f.want} (${className[f.wantClass]}). Visually confirm the family before changing it; extraction may be wrong.` });
  for (const w of fit.wraps) fixes.push({ weight: 400 + 50 * Math.abs(w.rendered - w.target),
    text: `${w.id}: ${w.rendered} rendered lines versus ${w.target} extracted at the reference width. Check wording, container width and font. Preserve natural wrapping at smaller widths.` });
  const grouped = new Set();
  const groups = facts.review?.containers || facts.sections.map(s => ({ id: s.id, items: s.items.map(i => i.id) }));
  for (const group of groups) {
    const positions = fit.positions.filter(p => group.items.includes(p.id) && !grouped.has(p.id));
    for (const anchor of positions) {
      const matches = positions.filter(p => !grouped.has(p.id) && Math.abs(p.dx - anchor.dx) <= 4 && Math.abs(p.dy - anchor.dy) <= 4);
      if (matches.length < 3 || Math.max(Math.abs(anchor.dx), Math.abs(anchor.dy)) <= 8) continue;
      matches.forEach(p => grouped.add(p.id));
      fixes.push({ weight: 1050, text: `${group.id}: ${matches.length} items share approximately dx=${anchor.dx}px, dy=${anchor.dy}px (${matches.map(p => p.id).join(', ')}). Inspect the common container once. Reference coordinates are page-relative: never add them to a positioned parent's offset. Keep intentional overlays inside their positioned section.` });
    }
  }
  for (const p of fit.positions.filter(p => !grouped.has(p.id))) {
    const isText = byId.get(p.id)?.type === 'text';
    const limit = isText ? 3 : 4;
    const off = Math.max(Math.abs(p.dx), Math.abs(p.dy), Math.abs(p.dw || 0), Math.abs(p.dh || 0));
    if (off <= limit) continue;
    const parts = [];
    if (Math.abs(p.dx) > limit) parts.push(`move ${p.dx > 0 ? 'left' : 'right'} ${Math.abs(p.dx)}px`);
    if (Math.abs(p.dy) > limit) parts.push(`move ${p.dy > 0 ? 'up' : 'down'} ${Math.abs(p.dy)}px`);
    if (p.dw && Math.abs(p.dw) > limit) parts.push(`make it ${Math.abs(p.dw)}px ${p.dw > 0 ? 'narrower' : 'wider'}`);
    if (p.dh && Math.abs(p.dh) > limit) parts.push(`make it ${Math.abs(p.dh)}px ${p.dh > 0 ? 'shorter' : 'taller'}`);
    const it = byId.get(p.id);
    const target = isText ? `first line: ink starts x ${it.lines[0].box[0]}, baseline y ${it.lines[0].baseline}` : `box ${(it.fileBox || it.box).join(', ')}`;
    fixes.push({ weight: Math.min(off, 200), text: `${p.id}: reference delta suggests ${parts.join(', ')} (${target}, page coordinates). Confirm the containing block before editing local offsets.` });
  }
  for (const b of report.pageHealth?.brokenImages || []) fixes.push({ weight: 900, text: `Broken image: ${b.src}. Use ./assets/… or ./icons/… paths (files are in site/public).` });
  if (report.pageHealth?.horizontalOverflow) fixes.push({ weight: 800, text: `The page is wider than ${facts.viewport.width}px; something overflows horizontally.` });
  return fixes.sort((a, b) => b.weight - a.weight);
}

export async function fastCheck({ out = 'work' }) {
  const state = await readJson(stateFile(out));
  const session = await readJson(path.join(state.runs, 'session.json')).catch(() => null);
  const used = session?.runCount ?? 0;
  const facts = await readJson(path.join(state.work, state.review ? 'reviewed-facts.json' : 'facts.json'));
  const timings = {};
  let t = performance.now();
  // Checking is observational: it never rewrites the agent's styles or font choices.
  let built;
  try { built = await viteBuild(state.site); }
  catch (error) { return { status: 'build-failed', markdown: `# Build failed (no check used)\n\nFix this error and run check again:\n\n\`\`\`\n${String(error.message).slice(-1800)}\n\`\`\`\n` }; }
  timings.build = Math.round(performance.now() - t);
  t = performance.now();
  const fit = await fitPage({ html: built.html, facts, adjust: false });
  timings.fit = Math.round(performance.now() - t);
  t = performance.now();
  const { Evaluator } = await import('./evaluator.mjs');
  const evaluator = new Evaluator({ target: state.screenshot, html: built.html, out: state.runs, inventoryPath: path.join(state.work, state.review ? 'reviewed-inventory.json' : 'page-inventory.json'),
    maxRuns: state.maxRuns, siteDir: state.site, allowSourceChange: true, softLimits: true });
  let report;
  try { report = await evaluator.run(); } finally { await evaluator.close(); }
  timings.compare = Math.round(performance.now() - t);
  t = performance.now();
  if (!state.firstRenderAt) { state.firstRenderAt = report.createdAt; await fs.writeFile(stateFile(out), JSON.stringify(state,null,2)); }
  await fs.writeFile(path.join(report.runDir,'check-details.json'),JSON.stringify({status:'in-progress',stage:'responsive',report:report.run,fit},null,2));
  let viewports;
  try { viewports = await checkViewports({ html: built.html, facts, runDir: report.runDir, verifyWording: Boolean(state.review) || state.draft }); }
  catch(error) { viewports = await readJson(path.join(report.runDir,'responsive.json')).catch(()=>[]); viewports.push({width:null,status:'incomplete',issues:[{kind:'verification-incomplete',id:'checker',severity:'error',message:error.message}]}); }
  timings.responsive = Math.round(performance.now() - t);
  const fixes = fixList({ fit, report, facts });
  const issues = viewports.flatMap(v => v.issues.map(i => ({ ...i, width: v.width })));
  issues.push(...(report.readinessIssues || []));
  for (const issue of issues) fixes.push({ weight: issue.kind==='container-geometry'||issue.kind==='container-ownership' ? 1050 : issue.severity === 'error' ? 1200 : 50, text: `${issue.width}px / ${issue.id}: ${issue.message}` });
  const assets = assetAudit(facts);
  for (const asset of assets.unresolved) fixes.push({ weight: 850, text: `Unresolved image ${asset.id}: ${asset.reason}. Visual fidelity remains incomplete until a usable source is supplied or generated.` });
  for (const ids of assets.overlaps) fixes.push({ weight: 80, text: `Review overlapping image crops ${ids.join(', ')}. If they span separate components, separate them in one fast review asset batch.` });
  fixes.sort((a, b) => b.weight - a.weight);
  for (const entry of assets.replacementCandidates || []) fixes.push({weight:840,text:`Asset overlap ${entry.ids.join(', ')}: ${entry.action}`});
  const complete = viewports.every(v=>v.status!=='incomplete') && !(report.readinessIssues || []).length;
  const candidate = { complete, run: report.run, path: report.runDir, errors: issues.filter(i => i.severity === 'error').length, differingFraction: report.differingFraction,
    layout: report.visualScores.layout?.differingFraction ?? report.differingFraction, unresolvedAssets: assets.unresolved.length, reviewed: Boolean(state.review) || state.draft, reviewHash: state.review?.hash || null };
  const previousBest = await readJson(path.join(state.work, 'best-check.json')).catch(() => null);
  const best = !complete ? previousBest : !previousBest || (candidate.reviewed && previousBest.reviewed === false) || (candidate.reviewed === (previousBest.reviewed ?? candidate.reviewed) &&
    (candidate.errors < previousBest.errors || (candidate.errors === previousBest.errors && candidate.differingFraction < previousBest.differingFraction))) ? candidate : previousBest;
  if(best) await fs.writeFile(path.join(state.work, 'best-check.json'), JSON.stringify(best, null, 2));
  const budget = fastBudget(state);
  await fs.writeFile(path.join(report.runDir, 'check-details.json'), JSON.stringify({ status:complete?'complete':'incomplete', candidate, best, viewports, assets, fit, fixes, reviewHash: state.review?.hash || null, budget, extraRound: report.run > state.maxRuns, provisional: !state.review && !state.draft }, null, 2));
  if (!state.firstRenderAt) { state.firstRenderAt = report.createdAt; await fs.writeFile(stateFile(out), JSON.stringify(state, null, 2)); }
  const previous = used ? await readJson(path.join(state.runs, `run-${String(used).padStart(2, '0')}`, 'report.json')).catch(() => null) : null;
  const remaining = Math.max(0, state.maxRuns - report.run);
  const gain = previous ? previous.differingFraction - report.differingFraction : null;
  let verdict;
  if (!complete) verdict = 'Verification incomplete. Desktop evidence is saved; resolve the resource or checker error and rerun. This is not a quality pass.';
  else if (!remaining || budget.exhausted) verdict = 'Target exceeded or recommended rounds reached. Tools remain available and further calls are logged. This is not a quality pass; assess remaining defects before continuing.';
  else if (best?.run !== report.run) verdict = `Run ${best.run} has fewer browser health errors or a better visual score with equal errors. Inspect both; fast restore-best can restore it. ${remaining} repair round(s) remain.`;
  else if (gain != null && gain < 0.002 && !fixes.some(f => f.weight > 80)) verdict = 'Measured progress has plateaued. Consider finishing and report unresolved limitations.';
  else if (!fixes.length) verdict = 'Automated checks found no listed issues. Inspect all saved renders before claiming visual quality or functionality.';
  else verdict = `Review the evidence and render together, correct mistaken assumptions, then batch the largest repairs (${remaining} round(s) left).`;
  const L = [`# Check ${report.run} of ${state.maxRuns}`, '',
    `Elapsed ${budget.elapsedMinutes.toFixed(1)} min; target ${state.maxMinutes} min; over target ${budget.overTargetMinutes.toFixed(1)} min. Additional rounds: ${Math.max(0, report.run-state.maxRuns)}.`,
    state.review || state.draft ? 'Reviewed evidence used.' : 'PROVISIONAL: visual review has not completed. Raw measurement hints may be wrong; wording assertions are disabled. Checking remains available.',
    `Differing pixels: ${pct(report.differingFraction)}${previous ? ` (previous ${pct(previous.differingFraction)})` : ''}. Non-media pixels ${pct(report.visualScores.layout?.differingFraction ?? 0)}, images ${report.visualScores.media ? pct(report.visualScores.media.differingFraction) : 'n/a'}.`,
    'Pixel difference is not a design-quality percentage. Media/non-media masks exclude mapped text and controls; text appearance still needs inspection over missing backgrounds.',
    'Font fitting is disabled. No source styles were changed by this check.',
    `Browser health: ${candidate.errors} error(s) across ${viewports.map(v => `${v.width}px`).join(', ')}. Unresolved images: ${assets.unresolved.length}.`,
    `Best saved run: ${best?.run ?? 'none (verification incomplete)'} (browser health first, then pixel difference).`, '',
    `**${verdict}**`, ''];
  if (fixes.length) {
    L.push('## Fix (largest first)', '');
    for (const f of fixes.slice(0, 20)) L.push(`- ${f.text}`);
    if (fixes.length > 20) L.push(`- ${fixes.length - 20} additional observations are saved in check-details.json.`);
    L.push('', `Worst sections: ${report.regions.slice(0, 3).map(r => `${r.id} (${r.meanColorError})`).join(', ')}. Compare ${path.join(report.runDir, 'overlay.png')} with the screenshot if a section is clearly wrong.`);
  }
  L.push('', `Render: ${path.join(report.runDir, 'render.png')}`,
    ...viewports.filter(v => v.render).map(v => `Responsive render (${v.width}px): ${path.join(report.runDir, v.render)}`), '',
    `Tool time: build ${timings.build} ms, inspect text ${timings.fit} ms, compare ${timings.compare} ms, responsive checks ${timings.responsive} ms.`);
  const markdown = L.join('\n') + '\n';
  await fs.writeFile(path.join(report.runDir, 'check.md'), markdown);
  return { status: !complete ? 'incomplete' : budget.exhausted || !remaining ? 'over-target' : 'continue', budget, extraRound: report.run > state.maxRuns, run: report.run, remaining, differingFraction: report.differingFraction, best, timings, markdown };
}

export async function fastRestoreBest({ out = 'work' }) {
  const state = await readJson(stateFile(out));
  const session = await readJson(path.join(state.runs, 'session.json'));
  const best = await readJson(path.join(state.work, 'best-check.json')).catch(() => state.version>=5 ? null : session.best);
  if(!best) throw new Error('No fully checked candidate is available to restore. Inspect the saved renders and incomplete-check diagnostics first.');
  const snapshot = path.join(best.path, 'source');
  await fs.cp(snapshot, state.site, { recursive: true, force: true });
  await viteBuild(state.site);
  return { restoredRun: best.run, site: state.site };
}

export async function fastTiming({ out = 'work' }) {
  const state = await readJson(stateFile(out));
  const log = (await fs.readFile(path.join(state.work, 'timing.jsonl'), 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const events=log.filter(e=>e.type!=='tool-start');
  const unfinished=log.filter(e=>e.type==='tool-start' && !(e.pid===process.pid && e.command==='fast timing') && !events.some(end=>end.operationId===e.operationId)).map(e=>{
    let alive=false;try {process.kill(e.pid,0);alive=true;}catch{}
    return {...e,status:alive?'running-or-pid-reused':'interrupted-without-end-record'};
  });
  const reports=[];
  for(const name of await fs.readdir(state.runs).catch(()=>[])) if(/^run-\d+$/.test(name)) {
    const report=await readJson(path.join(state.runs,name,'report.json')).catch(()=>null);
    if(report) reports.push({run:report.run,createdAt:report.createdAt,verification:(await readJson(path.join(state.runs,name,'check-details.json')).catch(()=>null))?.status || 'not-completed'});
  }
  reports.sort((a,b)=>a.run-b.run);
  const start = Date.parse(state.startedAt);
  const checks = events.filter(e => e.command === 'fast check' && e.status === 'ok' && Number.isInteger(e.run));
  const initEvent = events.find(e => e.command === 'fast init' && e.status === 'ok');
  if (state.version >= 2 && state.draft && initEvent) checks.unshift({ ...initEvent, note: 'draft check (run by init)' });
  const init = events.find(e => e.command === 'fast init');
  const last = new Date().toISOString();
  const totals = summarizeIntervals(events, start, Date.parse(last));
  const toolMs = totals.trackedMs;
  const summary = { startedAt: state.startedAt, finishedAt: last, totalMinutes: Math.round((Date.parse(last) - start) / 6000) / 10,
    factsSeconds: init ? Math.round(init.durationMs / 100) / 10 : null,
    checks: checks.map((c, i) => ({ check: i + 1, minutesFromStart: Math.round((Date.parse(c.endedAt) - start) / 6000) / 10, toolSeconds: Math.round(c.durationMs / 100) / 10, ...(c.note ? { note: c.note } : {}) })),
    toolMinutes: Math.round(toolMs / 6000) / 10, untrackedMinutes: Math.round(totals.untrackedMs / 6000) / 10,
    firstRenderMinutes: state.firstRenderAt || reports[0]?.createdAt ? (Date.parse(state.firstRenderAt || reports[0].createdAt)-start)/60000 : null,
    renderedChecks:reports, unfinishedCalls:unfinished,
    toolCalls: events.length, failedCalls: events.filter(e=>e.status==='failed').length, externalCalls: events.filter(e=>e.command==='fast exec').length,
    callsAfterTarget: events.filter(e=>e.afterTarget).length, extraRounds: Math.max(0,reports.length-state.maxRuns), byCommand: totals.byCommand,
    otherToolCalls: events.filter(e => !e.command.startsWith('fast')).length,
    review: state.review || null, budget: fastBudget(state),
    note: 'Elapsed includes the interval through this report. Tracked intervals are unioned to avoid counting nested/parallel calls twice. Untracked time includes reasoning, edits, unwrapped commands and idle time. Use fast exec for external commands. Targets never disable fast tools.' };
  await fs.writeFile(path.join(state.work, 'timing-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}
