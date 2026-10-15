// Make an isolated test folder for the fast path: screenshot, brief, skill, tools and dependencies only.
// Usage: node scripts/pack-fast.mjs <screenshot.png> <fresh-folder> [--assets-dir=<originals>]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [screenshot, destination] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const assetsDir = process.argv.find(a => a.startsWith('--assets-dir='))?.slice('--assets-dir='.length);
if (!screenshot || !destination) throw new Error('Usage: node scripts/pack-fast.mjs <screenshot.png> <fresh-folder> [--assets-dir=<dir>]');
const out = path.resolve(destination);
if (await fs.access(out).then(() => true).catch(() => false)) throw new Error(`${out} already exists. Choose a fresh folder.`);

await fs.mkdir(out, { recursive: true });
for (const name of ['bin', 'src']) await fs.cp(path.join(root, name), path.join(out, name), { recursive: true });
await fs.mkdir(path.join(out, 'scripts'), { recursive: true });
await fs.copyFile(path.join(root, 'scripts', 'validate-inventory.mjs'), path.join(out, 'scripts', 'validate-inventory.mjs'));
if (await fs.access(path.join(root, '.cache')).then(() => true).catch(() => false)) {
  await fs.cp(path.join(root, '.cache'), path.join(out, '.cache'), { recursive: true });
}
const templateSource = path.join(root, 'templates', 'react-vite');
await fs.cp(templateSource, path.join(out, 'templates', 'react-vite'), { recursive: true, filter: s => !path.relative(templateSource, s).split(path.sep).includes('node_modules') });
await fs.cp(path.join(root, 'skills', 'image-to-code-fast'), path.join(out, 'skill'), { recursive: true });
await fs.copyFile(path.resolve(screenshot), path.join(out, 'screenshot.png'));
if (assetsDir) await fs.cp(path.resolve(assetsDir), path.join(out, 'assets'), { recursive: true });

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
pkg.scripts = { tool: pkg.scripts.tool };
await fs.writeFile(path.join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
await fs.copyFile(path.join(root, 'package-lock.json'), path.join(out, 'package-lock.json'));

const brief = `Recreate screenshot.png as an editable, responsive React frontend. Follow skill/SKILL.md: automatic evidence, a short visual review, the generated design brief plus the screenshot, then coding and browser checks. Aim for a first render by minute five and completion by minute ten, normally with two repair rounds. These are observational targets: keep using tools after overruns and log further work. Use fast exec for extra commands. Report visual differences, responsive and interaction results, time and unresolved assets honestly.${assetsDir ? ' Supplied originals are in assets/; pass --assets-dir assets.' : ' Only the screenshot is supplied; identify any unavailable original assets explicitly.'}\n`;
await fs.writeFile(path.join(out, 'BRIEF.md'), brief);
const rules = 'Treat this directory as the complete project. Do not inspect parent or sibling directories. Read BRIEF.md and follow skill/SKILL.md. Keep all files inside this directory.\n';
await fs.writeFile(path.join(out, 'AGENTS.md'), rules);
await fs.writeFile(path.join(out, 'CLAUDE.md'), rules);
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const sources = [...(await fs.readdir(path.join(out, 'src'))).filter(n => n.endsWith('.mjs')).map(n => `src/${n}`), 'bin/image-to-code.mjs', 'skill/SKILL.md', 'skill/references/review-plan.md'];
await fs.writeFile(path.join(out, 'trial-manifest.json'), JSON.stringify({ version: 5, createdAt: new Date().toISOString(), screenshotSha256: await hash(path.join(out, 'screenshot.png')),
  suppliedOriginals: Boolean(assetsDir), maxMinutes: 10, maxRounds: 3, limitMode: 'observe', checkWidths: ['reference', 768, 390, 'up to four breakpoint pairs'],
  sources: Object.fromEntries(await Promise.all(sources.map(async name => [name, await hash(path.join(out, name))]))) }, null, 2));

process.stdout.write('Copying dependencies...\n');
if (!await fs.access(path.join(root, 'node_modules')).then(() => true).catch(() => false)) throw new Error('Install toolkit dependencies with npm ci before packing a trial.');
await fs.cp(path.join(root, 'node_modules'), path.join(out, 'node_modules'), { recursive: true });
process.stdout.write('Installing React template dependencies from its lockfile...\n');
await new Promise((resolve,reject) => {
  const win=process.platform==='win32';
  const child=spawn(win?(process.env.ComSpec || 'cmd.exe'):'npm',
    win?['/d','/s','/c','npm ci --no-audit --no-fund']:['ci','--no-audit','--no-fund'],
    { cwd:path.join(out,'templates','react-vite'), windowsHide:true, stdio:'inherit' });
  child.on('error',reject);
  child.on('exit',code=>code===0?resolve():reject(new Error(`React template npm ci failed with exit ${code}.`)));
});
process.stdout.write(`Test folder ready: ${out}\n`);
