import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { preparePage } from './prepare.mjs';
import { ingestCompactPlan } from './compact-plan.mjs';
import { renderQuickPage } from './quick-render.mjs';
import { generateReactSite, buildReactSite, syncReactAssets } from './react-render.mjs';
import { planAssets } from './assets.mjs';
import { startSession } from './session-server.mjs';
import { makeRepairPlan } from './repair-plan.mjs';
import { enrichInventoryColors } from './design-hints.mjs';
import { saveInventoryAudit } from './inventory-audit.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/validate-inventory.mjs');
const stateFile = out => path.join(path.resolve(out), 'workflow.json');
const deadlineAt = state => state.maxMinutes == null ? null : new Date(Date.parse(state.startedAt) + state.maxMinutes * 60000).toISOString();
function checkDeadline(state) {
  if (deadlineAt(state) && Date.now() >= Date.parse(deadlineAt(state)))
    throw new Error(`Time budget reached (${state.maxMinutes} minutes) for this first pass. Stop and report the best saved render.`);
}
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function exists(file) { return fs.access(file).then(() => true).catch(() => false); }
async function save(state) { await fs.writeFile(stateFile(state.out), JSON.stringify(state, null, 2) + '\n'); }
async function validate(file) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', error => resolve({ valid: false, message: error.message }));
    child.on('exit', code => resolve({ valid: code === 0, message: output.trim() }));
  });
}

export async function initWorkflow({ screenshot, out, briefPath, visionFile, model, endpoint, language, detectorFile, detectorCommand, assetsDir, maxRuns = 3, maxMinutes = 15 }) {
  const limit = Number(maxRuns);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--max-runs must be a positive integer.');
  const minutes = Number(maxMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('--max-minutes must be positive.');
  if (await exists(stateFile(out))) throw new Error('Workflow already exists in this output directory. Use workflow status or choose a fresh directory.');
  const prepared = await preparePage({ screenshot, out, briefPath, visionFile, model, endpoint, language, detectorFile, detectorCommand, assetsDir });
  const directory = path.resolve(out);
  const state = { version: 1, startedAt: new Date().toISOString(), out: directory, screenshot: path.resolve(screenshot), briefPath: briefPath ? path.resolve(briefPath) : null,
    evidence: prepared.evidence, assetCatalog: prepared.assetCatalog, contactSheet: prepared.contactSheet,
    draftInventory: prepared.inventory, inventory: path.join(directory, 'page-inventory.json'),
    candidate: null, runs: path.join(directory, 'runs'), maxRuns: limit, maxMinutes: minutes };
  await save(state);
  return workflowStatus(directory);
}

export async function ingestWorkflowPlan({ out, planFile }) {
  const state = await readJson(stateFile(out));
  checkDeadline(state);
  const evidence = await readJson(state.evidence);
  const result = await ingestCompactPlan({ planFile, screenshot: state.screenshot, out: state.out,
    brief: evidence.brief, viewport: { width: evidence.inspection.width, height: evidence.inspection.height } });
  const inventory = await readJson(result.file);
  const hints = await enrichInventoryColors(inventory, state.screenshot);
  if (hints.length) await fs.writeFile(result.file, JSON.stringify(inventory, null, 2) + '\n');
  const validation = await validate(result.file);
  if (!validation.valid) {
    await fs.rm(result.file, { force: true });
    throw new Error(`Compact plan could not produce a valid inventory: ${validation.message}`);
  }
  state.compactPlan = path.resolve(planFile);
  const audit = await saveInventoryAudit({ inventoryFile: result.file, evidenceFile: state.evidence,
    out: path.join(state.out, 'inventory-audit.json') });
  await save(state);
  return { ...result, colorHints: hints.length, audit, status: await workflowStatus(out) };
}

export async function quickFirstRender({ out, planFile, siteDir }) {
  checkDeadline(await readJson(stateFile(out)));
  if (planFile) await ingestWorkflowPlan({ out, planFile });
  const state = await readJson(stateFile(out));
  const status = await workflowStatus(out);
  if (!status.validation.valid) throw new Error(`A compact plan or valid inventory is required: ${status.validation.message}`);
  if (deadlineAt(state) && Date.now() >= Date.parse(deadlineAt(state))) throw new Error(`Time budget reached (${state.maxMinutes} minutes) for this first pass.`);
  if (status.runCount !== 0 || state.candidate) throw new Error('Quick first render only runs before a candidate has been bound or compared.');
  const scaffold = siteDir ? await generateReactSite({ inventoryFile: state.inventory, siteDir, evidenceFile: state.evidence }) :
    await renderQuickPage({ inventoryFile: state.inventory, evidenceFile: state.evidence,
      out: path.join(state.out, 'first-render.html') });
  const built = siteDir ? await buildReactSite(siteDir) : { html: scaffold.file };
  await bindCandidate({ out, html: built.html, siteDir });
  const report = await compareWorkflow(out);
  return { scaffold, comparison: summarizeComparison(report), next: siteDir ?
    'Edit the generated React source, run workflow build --out <work-dir>, then compare again.' :
    'Build or refine the frontend from the compact plan and first comparison. Bind its URL or HTML before the next comparison.' };
}

export async function buildWorkflowReact(out) {
  const state = await readJson(stateFile(out));
  checkDeadline(state);
  if (!state.siteDir) throw new Error('No generated site is bound to this workflow.');
  await syncReactAssets({ inventoryFile: state.inventory, siteDir: state.siteDir });
  const built = await buildReactSite(state.siteDir);
  await bindCandidate({ out, html: built.html, siteDir: state.siteDir });
  return built;
}

export async function bindCandidate({ out, html, url, siteDir }) {
  if (Boolean(html) === Boolean(url)) throw new Error('Bind exactly one of --html or --url.');
  const state = await readJson(stateFile(out));
  checkDeadline(state);
  if (siteDir) {
    const relative = path.relative(path.resolve(siteDir), state.out);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))
      throw new Error('--site-dir cannot contain the workflow output directory. Keep work and site in sibling folders.');
  }
  state.candidate = html ? { html: path.resolve(html) } : { url };
  // A URL may point at a different dev server than the saved source tree. Vite,
  // Next, and similar frontend servers expose files in public/ at the URL root.
  if (url && siteDir) {
    const token = crypto.randomBytes(16).toString('hex');
    const name = `__i2c_identity_${token}.json`;
    const publicDir = path.join(path.resolve(siteDir), 'public');
    await fs.mkdir(publicDir, { recursive: true });
    await fs.writeFile(path.join(publicDir, name), JSON.stringify({ token }) + '\n');
    state.candidate.siteProof = { token, path: `/${name}` };
  }
  state.siteDir = siteDir ? path.resolve(siteDir) : state.siteDir ?? null;
  await save(state);
  return workflowStatus(out);
}

export async function workflowStatus(out) {
  const state = await readJson(stateFile(out));
  const gapFile = path.join(state.out, 'tool-gap.json');
  const toolGap = await exists(gapFile) ? await readJson(gapFile) : null;
  const auditFile = path.join(state.out, 'inventory-audit.json');
  const inventoryAudit = await exists(auditFile) ? await readJson(auditFile) : null;
  const inventoryExists = await exists(state.inventory);
  let validation = inventoryExists ? await validate(state.inventory) : { valid: false, message: 'Inventory has not been saved as page-inventory.json.' };
  if (validation.valid && (await readJson(state.inventory)).draft === true)
    validation = { valid: false, message: 'Inventory is still the automatic draft. Review and classify it, then remove draft:true.' };
  let assets = [];
  if (validation.valid) {
    assets = await planAssets(state.inventory);
  }
  const session = await exists(path.join(state.runs, 'session.json')) ? await readJson(path.join(state.runs, 'session.json')) : null;
  const runCount = session?.runCount ?? 0;
  const elapsedMinutes = Math.round(10 * (Date.now() - Date.parse(state.startedAt)) / 60000) / 10;
  const timeRemainingMinutes = state.maxMinutes == null ? null : Math.max(0, Math.round(10 * (state.maxMinutes - elapsedMinutes)) / 10);
  const pendingAssets = assets.filter(asset => !asset.ready).map(asset => ({ id: asset.id, kind: asset.kind, route: asset.route, nextAction: asset.nextAction }));
  let stage, next;
  if (deadlineAt(state) && Date.now() >= Date.parse(deadlineAt(state))) { stage = 'time-budget-reached'; next = 'Stop this pass now. Report the best saved render and remaining mismatches. Do not continue probing or editing.'; }
  else if (toolGap) { stage = 'tool-gap'; next = 'A required measurement is not covered by the tools. Review tool-gap.json before continuing.'; }
  else if (!validation.valid) { stage = 'inventory'; next = 'Write one short first-pass plan from your own vision, then run workflow first-render --out <work-dir> --plan <file>. Skip pixel probes and asset extraction until after that render.'; }
  else if (!state.candidate || (state.candidate.html && !await exists(state.candidate.html))) { stage = 'first-render-ready'; next = 'Run workflow first-render --out <work-dir> now. It creates and compares a rough page automatically.'; }
  else if (runCount >= state.maxRuns) { stage = 'done'; next = 'Inspect the best run and report remaining mismatches.'; }
  else { stage = runCount === 0 ? 'first-render' : 'repair'; next = runCount === 0 ? 'Start the comparison session and render once.' : 'Fix the top reported issue, then compare again if the budget remains.'; }
  return { stage, next, toolGap, inventoryAudit, screenshot: state.screenshot, evidence: state.evidence,
    assetCatalog: state.assetCatalog, contactSheet: state.contactSheet,
    inventory: state.inventory,
    validation, pendingAssets, candidate: state.candidate, runCount, remaining: Math.max(0, state.maxRuns - runCount),
    best: session?.best ?? null, runs: state.runs, elapsedMinutes, timeRemainingMinutes };
}

export async function startWorkflowSession(out, port = 0) {
  const state = await readJson(stateFile(out));
  const status = await workflowStatus(out);
  if (!status.validation.valid) throw new Error(`Inventory is not valid: ${status.validation.message}`);
  if (deadlineAt(state) && Date.now() >= Date.parse(deadlineAt(state))) throw new Error(`Time budget reached (${state.maxMinutes} minutes) for this first pass.`);
  if (status.toolGap) throw new Error('A tool gap is recorded. Resolve tool-gap.json before running comparisons.');
  if (!state.candidate) throw new Error('Bind a candidate with workflow bind before starting a session.');
  return startSession({ target: state.screenshot, ...state.candidate, out: state.runs, inventoryPath: state.inventory,
    maxRuns: state.maxRuns, siteDir: state.siteDir, allowSourceChange: true, deadlineAt: deadlineAt(state), port });
}

export async function compareWorkflow(out) {
  const state = await readJson(stateFile(out));
  const status = await workflowStatus(out);
  if (status.runCount >= state.maxRuns) throw new Error(`Run limit reached (${state.maxRuns}) for this workflow.`);
  if (deadlineAt(state) && Date.now() >= Date.parse(deadlineAt(state))) throw new Error(`Time budget reached (${state.maxMinutes} minutes) for this first pass.`);
  if (!status.validation.valid) throw new Error(`Inventory is not valid: ${status.validation.message}`);
  if (status.toolGap || !state.candidate)
    throw new Error(`Workflow is at ${status.stage}; complete that stage before comparing.`);
  const { Evaluator } = await import('./evaluator.mjs');
  const evaluator = new Evaluator({ target: state.screenshot, ...state.candidate, out: state.runs,
    inventoryPath: state.inventory, maxRuns: state.maxRuns, siteDir: state.siteDir, allowSourceChange: true, deadlineAt: deadlineAt(state) });
  try {
    const report = await evaluator.run();
    const updated = await workflowStatus(out);
    report.repairPlan = await makeRepairPlan({ reportFile: path.join(report.runDir, 'report.json'), inventoryFile: state.inventory,
      remaining: updated.remaining, timeRemainingMinutes: updated.timeRemainingMinutes });
    await fs.writeFile(path.join(report.runDir, 'repair-plan.json'), JSON.stringify(report.repairPlan, null, 2) + '\n');
    await fs.writeFile(path.join(report.runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  }
  finally { await evaluator.close(); }
}

export function summarizeComparison(report) {
  return { run: report.run, maxRuns: report.maxRuns, remaining: report.remaining,
    differingFraction: report.differingFraction, meanColorError: report.meanColorError, visualScores: report.visualScores,
    best: report.best, topIssues: report.topIssues?.slice(0, 8),
    regions: report.regions?.slice(0, 5), brokenImages: report.pageHealth?.brokenImages?.length ?? 0,
    horizontalOverflow: report.pageHealth?.horizontalOverflow ?? false,
    repairPlan: report.repairPlan ?? null,
    report: path.join(report.runDir, 'report.json'), render: path.join(report.runDir, 'render.png'),
    overlay: path.join(report.runDir, 'overlay.png'), diff: path.join(report.runDir, 'diff.png') };
}

export async function workflowReport(out) {
  const state = await readJson(stateFile(out));
  const sessionFile = path.join(state.runs, 'session.json');
  if (!await exists(sessionFile)) throw new Error('No comparison run has been recorded yet.');
  const session = await readJson(sessionFile);
  const runDir = path.join(state.runs, `run-${String(session.runCount).padStart(2, '0')}`);
  return summarizeComparison({ ...await readJson(path.join(runDir, 'report.json')), runDir, best: session.best,
    remaining: Math.max(0, state.maxRuns - session.runCount) });
}

export async function restoreBest(out) {
  const state = await readJson(stateFile(out));
  if (!state.siteDir) throw new Error('Bind with --site-dir to save source snapshots.');
  const session = await readJson(path.join(state.runs, 'session.json'));
  if (!session.best?.path) throw new Error('No best run exists.');
  const snapshot = path.join(session.best.path, 'source');
  if (!await exists(snapshot)) throw new Error('Best run has no source snapshot.');
  await fs.cp(snapshot, state.siteDir, { recursive: true, force: true });
  return { bestRun: session.best.run, restoredTo: state.siteDir, source: snapshot };
}

export async function workflowForInventory(inventoryPath) {
  if (!inventoryPath) return null;
  const directory = path.dirname(path.resolve(inventoryPath));
  const file = stateFile(directory);
  if (!await exists(file)) return null;
  const state = await readJson(file);
  return path.resolve(state.inventory) === path.resolve(inventoryPath) ? state : null;
}

export async function workflowForOutput(outputPath) {
  if (!outputPath) return null;
  const output = path.resolve(outputPath);
  let directory = output;
  while (true) {
    if (await exists(stateFile(directory))) {
      const state = await readJson(stateFile(directory));
      const relative = path.relative(state.runs, output);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return state;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
