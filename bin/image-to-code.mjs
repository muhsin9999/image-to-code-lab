#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, requireArg } from '../src/common.mjs';
import { inspectScreenshot } from '../src/inspect.mjs';
import { analyzeScreenshot } from '../src/analyze.mjs';
import { measureScreenshot } from '../src/measure.mjs';
import { runRecipeFile } from '../src/ops.mjs';
import { preparePage } from '../src/prepare.mjs';
import { initWorkflow, ingestWorkflowPlan, quickFirstRender, buildWorkflowReact, bindCandidate, workflowStatus, startWorkflowSession, compareWorkflow, workflowForInventory, workflowForOutput, summarizeComparison, workflowReport, restoreBest } from '../src/workflow.mjs';
import { planAssets, extractAsset, resolveAsset, resolveAssetsBatch } from '../src/assets.mjs';
import { rankFonts } from '../src/fonts.mjs';
import { Evaluator } from '../src/evaluator.mjs';
import { startSession } from '../src/session-server.mjs';
import { inspectBrowser } from '../src/browser-inspect.mjs';
import { recordToolTiming, startToolTiming, timingReport } from '../src/timing.mjs';

const usage = `image-to-code <command> [options]

Fast path (start here):
  fast init       --screenshot <png> [--out work] [--site site] [--assets-dir <originals>] [--max-minutes 10] [--draft true]
                  Estimates text, fonts, colours, boxes, images and icons into work/facts.md
                  and creates a React starter in site/.
  fast review     --out <work> --plan <layout-plan.json>   Reconcile visual evidence, containers and assets.
  fast check      [--out work]   Build and compare at multiple widths. Time/round targets are observational.
  fast metrics    [--out work] [--jobs <json-array-file>]  Cached batch font measurements.
  fast exec       [--out work] --job <json-file>  Log an external command (program,args,cwd,label,reason).
  fast status     [--out work]   Time budget, review status and best saved check.
  fast restore-best [--out work] Copy the best checked source back into the site.
  fast timing     [--out work]   Time summary of the run.

Commands:
  analyze         --screenshot <png> [--language eng|none]
                  [--detector-file <json> | --detector-command <json-array>] [--out <json>]
  inspect         --screenshot <png> [--out <json>]
  measure         --screenshot <png> [--box x,y,w,h] [--points x,y;x,y]
                  [--row <y>] [--column <x>] [--ink dark|light]
                  [--ink-threshold <0-255>] [--edge-threshold <n>] [--out <json>]
  ops             --recipe <json> [--out <json>]
  prepare         --screenshot <png> --out <dir> [--brief <file>] [--assets-dir <dir>]
                  [--vision-file <inventory.json> | --model <openrouter-model>] [--language eng]
  workflow init   --screenshot <png> --out <dir> [--brief <file>] [--assets-dir <dir>]
                  [--vision-file <inventory.json> | --model <openrouter-model>] [--language eng]
                  [--detector-file <json> | --detector-command <json-array>] [--max-runs 3] [--max-minutes 15]
  workflow ingest --out <dir> --plan <compact-plan.json>
  workflow first-render --out <dir> [--plan <compact-plan.json>] [--site-dir <empty-dir>]
  workflow build  --out <dir>     Rebuild the generated React page after edits
  workflow assets-start --out <dir> [--provider openrouter --model <model> | --provider command --command <json-array>]
  workflow assets-status --out <dir>
  workflow status --out <dir>
  workflow bind   --out <dir> (--html <file> | --url <url>) [--site-dir <dir>]
  workflow compare --out <dir>
  workflow report  --out <dir>
  workflow timing  --out <dir>
  workflow restore-best --out <dir>
  workflow session --out <dir> [--port 0]
  page-inspect    --target <png> (--html <file> | --url <url>)
                  [--selector <css>] [--limit 400] [--out <json>]
  assets-plan     --inventory <json> [--out <json>]
  assets-extract  --screenshot <png> --out <png> --box x,y,w,h
                  [--inventory <json> --asset-id <id>] [--mask <png>] [--key-color #rrggbb]
  assets-resolve  --inventory <json> --asset-id <id> --out <png>
                  [--provider openrouter --model <image-model> | --provider command --command <program>]
  icons search    --query <words> [--top <n>]
  icons use       --name <lucide-name> --out <svg>
  fonts           --text <line> --target-width <px> [--target-height <px>]
                  [--size <px>] [--screenshot <png> --crop x,y,w,h]
                  [--font-dir <dir>] [--top <n>] [--out <json>]
  compare         --target <png> (--html <file> | --url <url>) --out <dir>
                  [--inventory <json>]
  session         --target <png> (--html <file> | --url <url>) --out <dir>
                  [--inventory <json>] [--max-runs 3] [--port 0]
  validate        --inventory <json>

Session endpoints: GET /status, POST /compare, POST /close.
All paths are relative to the current working directory. No command contains page-specific coordinates.`;

async function emit(value, file) {
  const string = JSON.stringify(value, null, 2) + '\n';
  if (file) { await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true }); await fs.writeFile(file, string); }
  process.stdout.write(string);
  return value;
}

async function run() {
  const [command, ...tokens] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') { process.stdout.write(usage + '\n'); return; }
  if (command === 'workflow') {
    const [action, ...rest] = tokens;
    if (!action || action === '--help') { process.stdout.write(usage + '\n'); return; }
    const options = parseArgs(rest);
    if (action === 'init') return emit(await initWorkflow({ screenshot: requireArg(options, 'screenshot'), out: requireArg(options, 'out'),
      briefPath: options.brief, visionFile: options['vision-file'], model: options.model, endpoint: options.endpoint,
      language: options.language, detectorFile: options['detector-file'], assetsDir: options['assets-dir'],
      detectorCommand: options['detector-command'] ? JSON.parse(options['detector-command']) : undefined,
      maxRuns: options['max-runs'] ?? 3, maxMinutes: options['max-minutes'] ?? 15 }));
    if (action === 'status') return emit(await workflowStatus(requireArg(options, 'out')));
    if (action === 'ingest') return emit(await ingestWorkflowPlan({ out: requireArg(options, 'out'), planFile: requireArg(options, 'plan') }));
    if (action === 'first-render') return emit(await quickFirstRender({ out: requireArg(options, 'out'), planFile: options.plan, siteDir: options['site-dir'] }));
    if (action === 'build') return emit(await buildWorkflowReact(requireArg(options, 'out')));
    if (action === 'assets-status') {
      const file = path.join(path.resolve(requireArg(options, 'out')), 'assets-status.json');
      return emit(JSON.parse(await fs.readFile(file, 'utf8')));
    }
    if (action === 'assets-start') {
      const directory = path.resolve(requireArg(options, 'out'));
      const workflow = await workflowStatus(directory);
      if (workflow.stage === 'time-budget-reached') throw new Error('Time budget reached. Stop this pass and report the best saved render.');
      const file = path.join(directory, 'assets-status.json');
      const existing = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
      if (existing?.status === 'running') throw new Error('Asset worker is already running. Check workflow assets-status.');
      const args = [fileURLToPath(import.meta.url), 'workflow', 'assets-worker', '--out', directory];
      for (const key of ['provider', 'model', 'endpoint', 'command']) if (options[key]) args.push(`--${key}`, options[key]);
      await fs.writeFile(file, JSON.stringify({ status: 'running', startedAt: new Date().toISOString() }, null, 2) + '\n');
      const child = spawn(process.execPath, args, { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return emit({ status: 'running', pid: child.pid, statusFile: file });
    }
    if (action === 'assets-worker') {
      const directory = path.resolve(requireArg(options, 'out'));
      const file = path.join(directory, 'assets-status.json');
      try {
        const result = await resolveAssetsBatch({ inventoryPath: path.join(directory, 'page-inventory.json'), outDir: path.join(directory, 'resolved-assets'),
          provider: options.provider || 'openrouter', model: options.model, endpoint: options.endpoint,
          generatorCommand: options.command ? JSON.parse(options.command) : undefined });
        await fs.writeFile(file, JSON.stringify({ status: 'complete', finishedAt: new Date().toISOString(), ...result }, null, 2) + '\n');
        return result;
      } catch (error) {
        await fs.writeFile(file, JSON.stringify({ status: 'failed', finishedAt: new Date().toISOString(), error: error.message }, null, 2) + '\n');
        throw error;
      }
    }
    if (action === 'bind') return emit(await bindCandidate({ out: requireArg(options, 'out'), html: options.html, url: options.url, siteDir: options['site-dir'] }));
    if (action === 'compare') return emit(summarizeComparison(await compareWorkflow(requireArg(options, 'out'))));
    if (action === 'report') return emit(await workflowReport(requireArg(options, 'out')));
    if (action === 'timing') return emit(await timingReport(requireArg(options, 'out')), path.join(requireArg(options, 'out'), 'timing-summary.json'));
    if (action === 'restore-best') return emit(await restoreBest(requireArg(options, 'out')));
    if (action === 'session') {
      const session = await startWorkflowSession(requireArg(options, 'out'), options.port ?? 0);
      process.stdout.write(JSON.stringify({ url: session.url, ...session.evaluator.status() }, null, 2) + '\n');
      const stop = async () => { await session.close(); process.exit(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      return;
    }
    throw new Error(`Unknown workflow action: ${action}`);
  }
  if (command === 'fast') {
    const [action, ...rest] = tokens;
    const options = parseArgs(rest);
    const { fastInit, fastReview, fastStatus, fastCheck, fastRestoreBest, fastTiming } = await import('../src/fast.mjs');
    if (action === 'init') {
      const result = await fastInit({ screenshot: requireArg(options, 'screenshot'), out: options.out || 'work', site: options.site || 'site',
        assetsDir: options['assets-dir'], maxRuns: options['max-runs'], maxMinutes: options['max-minutes'] ?? 10, draft: options.draft === 'true', language: options.language || 'eng' });
      process.stdout.write(`Facts ready in ${(result.timingsMs.total / 1000).toFixed(1)}s: ${result.textBlocks} text, ${result.boxes} boxes, ${result.images} images, ${result.icons} icons. ${result.firstCheck ? 'Draft page written to site/src/App.tsx.' : 'Starter site ready (empty page).'}\n\n`);
      if (result.firstCheck) process.stdout.write(result.firstCheck.markdown + '\n');
      process.stdout.write(`Next: ${result.next}\n`);
      return result;
    }
    if (action === 'check') {
      const result = await fastCheck({ out: options.out || 'work' });
      process.stdout.write(result.markdown);
      return result;
    }
    if (action === 'restore-best') return emit(await fastRestoreBest({ out: options.out || 'work' }));
    if (action === 'metrics') {
      const work=path.resolve(options.out || 'work');
      const { measureFontBatch }=await import('../src/batch-metrics.mjs');
      const facts=await fs.readFile(path.join(work,'reviewed-facts.json'),'utf8').catch(()=>fs.readFile(path.join(work,'facts.json'),'utf8')).then(JSON.parse);
      return emit(await measureFontBatch({work,facts,jobs:options.jobs?JSON.parse(await fs.readFile(options.jobs,'utf8')):undefined}));
    }
    if (action === 'exec') {
      const { trackedExec }=await import('../src/tracked-exec.mjs');
      const result=await trackedExec({out:options.out || 'work',jobFile:requireArg(options,'job')});
      if(result.exitCode) process.exitCode=result.exitCode;
      return emit(result);
    }
    if (action === 'review') return emit(await fastReview({ out: options.out || 'work', plan: requireArg(options, 'plan') }));
    if (action === 'status') return emit(await fastStatus({ out: options.out || 'work' }));
    if (action === 'timing') return emit(await fastTiming({ out: options.out || 'work' }));
    throw new Error(`Unknown fast action: ${action}`);
  }
  if (command === 'icons') {
    const [action, ...rest] = tokens;
    const options = parseArgs(rest);
    const { searchIcons, useIcon } = await import('../src/icons.mjs');
    if (action === 'search') return emit(await searchIcons(requireArg(options, 'query'), Number(options.top || 12)));
    if (action === 'use') return emit(await useIcon(requireArg(options, 'name'), requireArg(options, 'out')));
    throw new Error(`Unknown icons action: ${action}`);
  }
  const args = parseArgs(tokens);
  if (args.help) { process.stdout.write(usage + '\n'); return; }
  if (command === 'analyze') return emit(await analyzeScreenshot({ screenshot: requireArg(args, 'screenshot'),
    language: args.language || 'eng', detectorFile: args['detector-file'],
    detectorCommand: args['detector-command'] ? JSON.parse(args['detector-command']) : undefined }), args.out);
  if (command === 'inspect') return emit(await inspectScreenshot(requireArg(args, 'screenshot')), args.out);
  if (command === 'measure') return emit(await measureScreenshot({ screenshot: requireArg(args, 'screenshot'), box: args.box,
    points: args.points, row: args.row, column: args.column, ink: args.ink, inkThreshold: args['ink-threshold'],
    edgeThreshold: args['edge-threshold'], maxEdges: args['max-edges'] }), args.out);
  if (command === 'ops') return emit(await runRecipeFile(requireArg(args, 'recipe')), args.out);
  if (command === 'prepare') return emit(await preparePage({ screenshot: requireArg(args, 'screenshot'), out: requireArg(args, 'out'),
    briefPath: args.brief, visionFile: args['vision-file'], model: args.model, endpoint: args.endpoint,
    language: args.language, detectorFile: args['detector-file'], assetsDir: args['assets-dir'],
    detectorCommand: args['detector-command'] ? JSON.parse(args['detector-command']) : undefined,
    force: args.force === 'true' }));
  if (command === 'page-inspect') return emit(await inspectBrowser({ target: args.target, width: args.width ? Number(args.width) : undefined,
    height: args.height ? Number(args.height) : undefined, url: args.url, html: args.html, selector: args.selector,
    limit: args.limit ? Number(args.limit) : undefined, browserPath: args.browser }), args.out);
  if (command === 'assets-plan') return emit(await planAssets(requireArg(args, 'inventory')), args.out);
  if (command === 'assets-extract') return emit(await extractAsset({ screenshot: requireArg(args, 'screenshot'), out: requireArg(args, 'out'),
    box: args.box, inventoryPath: args.inventory, assetId: args['asset-id'], mask: args.mask, keyColor: args['key-color'], tolerance: args.tolerance }));
  if (command === 'assets-resolve') return emit(await resolveAsset({ inventoryPath: requireArg(args, 'inventory'), assetId: requireArg(args, 'asset-id'),
    out: requireArg(args, 'out'), provider: args.provider || 'openrouter', model: args.model, endpoint: args.endpoint,
    generatorCommand: args.command ? [args.command, ...(args['command-args'] ? JSON.parse(args['command-args']) : [])] : undefined }));
  if (command === 'fonts') return emit(await rankFonts({ text: requireArg(args, 'text'), targetWidth: Number(requireArg(args, 'target-width')),
    targetHeight: args['target-height'] ? Number(args['target-height']) : undefined, size: args.size ? Number(args.size) : undefined,
    screenshot: args.screenshot, crop: args.crop, fontDir: args['font-dir'], top: args.top ? Number(args.top) : undefined }), args.out);
  if (command === 'compare' || command === 'session') {
    const managed = await workflowForInventory(args.inventory) || await workflowForOutput(args.out);
    if (managed) {
      if (args.target && path.resolve(args.target) !== managed.screenshot ||
          (args.html && path.resolve(args.html) !== managed.candidate?.html) ||
          (args.url && args.url !== managed.candidate?.url))
        throw new Error('This inventory belongs to a workflow. Use its bound screenshot and candidate.');
      if (command === 'compare') return emit(summarizeComparison(await compareWorkflow(managed.out)));
      const session = await startWorkflowSession(managed.out, args.port ?? 0);
      process.stdout.write(JSON.stringify({ url: session.url, ...session.evaluator.status() }, null, 2) + '\n');
      const stop = async () => { await session.close(); process.exit(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      return;
    }
    const options = { target: requireArg(args, 'target'), url: args.url, html: args.html, out: requireArg(args, 'out'),
      inventoryPath: args.inventory, maxRuns: command === 'compare' ? 1 : args['max-runs'] ?? 3, port: args.port ?? 0, browserPath: args.browser };
    if (command === 'compare') {
      const evaluator = new Evaluator(options);
      try { return emit(await evaluator.run()); }
      finally { await evaluator.close(); }
    }
    const session = await startSession(options);
    process.stdout.write(JSON.stringify({ url: session.url, ...session.evaluator.status() }, null, 2) + '\n');
    const stop = async () => { await session.close(); process.exit(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return;
  }
  if (command === 'validate') {
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/validate-inventory.mjs');
    const child = spawn(process.execPath, [script, requireArg(args, 'inventory')], { stdio: 'inherit' });
    await new Promise((resolve, reject) => child.on('exit', code => code ? reject(new Error(`Inventory invalid (exit ${code}).`)) : resolve()));
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage}`);
}

const argv = process.argv.slice(2);
const startedAt = Date.now() - Math.round(process.uptime() * 1000);
const operation = await startToolTiming(argv,startedAt).catch(()=>null);
let ended=false;
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{
  if(!ended) { ended=true; await recordToolTiming(argv,startedAt,Date.now(),{status:'interrupted'},new Error(signal),operation).catch(()=>{}); }
  process.exit(signal==='SIGINT'?130:143);
});
run().then(async result => {
  if(!ended) await recordToolTiming(argv, startedAt, Date.now(), result, null, operation).catch(() => {});
  ended=true;
}).catch(async error => {
  if(!ended) await recordToolTiming(argv, startedAt, Date.now(), null, error, operation).catch(() => {});
  ended=true;
  process.stderr.write(error.message + '\n'); process.exitCode = 1;
});
