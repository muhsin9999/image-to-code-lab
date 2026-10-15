import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const exists = file => fs.access(file).then(() => true).catch(() => false);
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse);

export async function timingDirectory(argv, cwd = process.cwd()) {
  const ancestor = async start => {
    let current = path.resolve(start);
    while (true) {
      if (await exists(path.join(current, 'workflow.json')) || await exists(path.join(current, 'fast.json'))) return current;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  };
  const value = flag => { const index = argv.indexOf(flag); return index < 0 ? null : argv[index + 1]; };
  if (argv[0] === 'fast') return path.resolve(cwd, value('--out') || 'work');
  if (process.env.I2C_WORK) return path.resolve(process.env.I2C_WORK);
  const inventory = value('--inventory');
  if (inventory) return await ancestor(path.dirname(path.resolve(inventory))) || path.dirname(path.resolve(inventory));
  if (argv[0] === 'workflow') {
    const out = value('--out');
    if (out) return path.resolve(out);
  }
  const defaultWork = path.join(cwd, 'work');
  if (await exists(path.join(defaultWork, 'workflow.json')) || await exists(path.join(defaultWork, 'fast.json'))) return defaultWork;
  const out = value('--out');
  if (out) {
    const resolved = path.resolve(out);
    const directory = path.extname(resolved) ? path.dirname(resolved) : resolved;
    return await ancestor(directory) || directory;
  }
  return null;
}

export async function startToolTiming(argv, startedAt) {
  if (argv[0] === 'workflow' && argv[1] === 'timing') return null;
  const directory = await timingDirectory(argv);
  if (!directory) return null;
  await fs.mkdir(directory,{recursive:true});
  const operationId=crypto.randomUUID();
  const event={type:'tool-start',operationId,pid:process.pid,command:['fast','workflow','icons'].includes(argv[0])?argv.slice(0,2).join(' '):argv[0],startedAt:new Date(startedAt).toISOString(),status:'running'};
  await fs.appendFile(path.join(directory,'timing.jsonl'),JSON.stringify(event)+'\n');
  return {directory,operationId};
}

export async function recordToolTiming(argv, startedAt, endedAt, result, error, operation = null) {
  if (argv[0] === 'workflow' && argv[1] === 'timing') return;
  const directory = operation?.directory || await timingDirectory(argv);
  if (!directory || !await exists(directory)) return;
  const command = argv[0] === 'workflow' || argv[0] === 'icons' || argv[0] === 'fast' ? `${argv[0]} ${argv[1] || ''}`.trim() : argv[0];
  const state = await readJson(path.join(directory, 'fast.json')).catch(() => null);
  const deadline = state?.maxMinutes ? Date.parse(state.startedAt) + state.maxMinutes * 60000 : null;
  const event = { type: 'tool', operationId:operation?.operationId, command, startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(),
    durationMs: Math.max(0, Math.round(endedAt - startedAt)), status: result?.status === 'interrupted' ? 'interrupted' : error || ['build-failed','incomplete'].includes(result?.status) || result?.exitCode ? 'failed' : 'ok',
    afterTarget: deadline != null && endedAt > deadline, startedAfterTarget: deadline != null && startedAt > deadline,
    ...(result?.budget ? { budget: result.budget } : {}), ...(result?.extraRound ? { extraRound: true } : {}),
    ...(result?.execution ? { execution: result.execution, exitCode: result.exitCode } : {}),
    ...(result?.stage ? { stage: result.stage } : {}), ...(Number.isInteger(result?.run) ? { run: result.run } : {}),
    ...(error ? { error: String(error.message || error).slice(0, 250) } : {}) };
  await fs.appendFile(path.join(directory, 'timing.jsonl'), JSON.stringify(event) + '\n');
}

export function summarizeIntervals(events, start, end) {
  events = events.filter(e=>e.type!=='tool-start');
  const intervals = events.map(e => [Math.max(start, Date.parse(e.startedAt)), Math.min(end, Date.parse(e.endedAt))])
    .filter(([a,b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).sort((a,b)=>a[0]-b[0]);
  let trackedMs = 0, cursor = start;
  for (const [a,b] of intervals) { trackedMs += Math.max(0,b-Math.max(a,cursor)); cursor=Math.max(cursor,b); }
  const byCommand = Object.values(events.reduce((map,e)=>{
    const row=map[e.command] ||= {command:e.command,calls:0,failures:0,totalMs:0};row.calls++;row.failures+=e.status==='failed'?1:0;row.totalMs+=e.durationMs || 0;return map;
  },{}));
  return {trackedMs,untrackedMs:Math.max(0,end-start-trackedMs),byCommand};
}

export async function timingReport(out) {
  const directory = path.resolve(out);
  const state = await readJson(path.join(directory, 'workflow.json'));
  const lines = await fs.readFile(path.join(directory, 'timing.jsonl'), 'utf8').catch(() => '');
  const allEvents = lines.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const reports = [];
  for (let run = 1; run <= state.maxRuns; run++) {
    const file = path.join(state.runs, `run-${String(run).padStart(2, '0')}`, 'report.json');
    if (await exists(file)) {
      const report = await readJson(file);
      reports.push({ run, at: report.createdAt, evaluatorMs: report.timingsMs?.total ?? null,
        differingFraction: report.differingFraction, layoutDifference: report.visualScores?.layout?.differingFraction ?? null,
        mediaDifference: report.visualScores?.media?.differingFraction ?? null });
    }
  }
  const start = Date.parse(state.startedAt);
  const phases = [];
  let previous = start;
  for (const report of reports) {
    const at = Date.parse(report.at);
    phases.push({ phase: report.run === 1 ? 'start-to-first-render' : `render-${report.run - 1}-to-${report.run}`,
      wallMs: at - previous });
    previous = at;
  }
  const lastRender = reports.at(-1);
  const lastCompare = lastRender ? allEvents.filter(event => event.run === lastRender.run && ['workflow compare', 'compare'].includes(event.command)).at(-1) : null;
  const through = lastCompare?.endedAt || lastRender?.at || allEvents.at(-1)?.endedAt || state.startedAt;
  const events = allEvents.filter(event => Date.parse(event.endedAt) >= start && Date.parse(event.endedAt) <= Date.parse(through));
  const byCommand = Object.values(events.reduce((map, event) => {
    const row = map[event.command] ||= { command: event.command, calls: 0, totalMs: 0, failures: 0 };
    row.calls++; row.totalMs += event.durationMs; if (event.status === 'failed') row.failures++;
    return map;
  }, {})).sort((a, b) => b.totalMs - a.totalMs);
  const wallMs = Math.max(0, Date.parse(through) - start);
  const measuredToolMs = events.reduce((sum, event) => sum + event.durationMs, 0);
  const ordered = [...events].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const stageTransitions = ordered.filter((event, index) => event.stage && event.stage !== ordered.slice(0, index).reverse().find(item => item.stage)?.stage)
    .map(event => ({ at: event.endedAt, stage: event.stage }));
  const gaps = [];
  let prior = start;
  for (const event of ordered) {
    const next = Date.parse(event.startedAt);
    if (next > prior) gaps.push({ from: new Date(prior).toISOString(), to: event.startedAt, durationMs: next - prior });
    prior = Math.max(prior, Date.parse(event.endedAt));
  }
  if (Date.parse(through) > prior) gaps.push({ from: new Date(prior).toISOString(), to: through, durationMs: Date.parse(through) - prior });
  return { startedAt: state.startedAt, through, wallMs, phases, renders: reports,
    toolkitCalls: events.length, measuredToolMs, untrackedMs: Math.max(0, wallMs - measuredToolMs), byCommand,
    stageTransitions, longestUntrackedGaps: events.length ? gaps.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5) : [],
    note: events.length ? 'Untracked time includes agent reasoning, code edits, file reads, commands outside this CLI, and idle time. It is not CPU time.' :
      'This run predates per-command timing. Only workflow milestones and evaluator durations are available.' };
}
