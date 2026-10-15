import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export async function trackedExec({out='work',jobFile}) {
  const job=JSON.parse(await fs.readFile(path.resolve(jobFile),'utf8'));
  if(typeof job.program!=='string' || !Array.isArray(job.args) || job.args.some(a=>typeof a!=='string') || !job.label?.trim() || !job.reason?.trim()) throw new Error('Execution job needs program, args[], label and reason.');
  const cwd=path.resolve(job.cwd || process.cwd());
  const rel=path.relative(process.cwd(),cwd);
  if(rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Execution cwd must stay inside the current project.');
  const execution={label:job.label,reason:job.reason,program:path.basename(job.program),cwd};
  // Shell parsing is explicit: use a shell program with separate arguments if necessary.
  const exitCode=await new Promise((resolve,reject)=>{
    const child=spawn(job.program==='node'?process.execPath:job.program,job.args,{cwd,shell:false,windowsHide:true,stdio:'inherit',env:{...process.env,I2C_WORK:path.resolve(out)}});
    child.on('error',reject);child.on('exit',(code,signal)=>resolve(code ?? (signal?1:0)));
  });
  return {execution,exitCode,status:exitCode?'failed':'ok'};
}
