import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const localRequire = createRequire(import.meta.url);
const bundled = process.env.IMAGE_TO_CODE_NODE_MODULES
  ? createRequire(path.join(path.resolve(process.env.IMAGE_TO_CODE_NODE_MODULES), 'package.json'))
  : null;

export function resolveDependency(name) {
  try { return localRequire.resolve(name); }
  catch (error) {
    if (bundled) return bundled.resolve(name);
    throw new Error(`Missing ${name}. Run npm install.`, { cause: error });
  }
}

export function requireDependency(name) { return localRequire(resolveDependency(name)); }
export async function importDependency(name) { return import(pathToFileURL(resolveDependency(name)).href); }

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'help') { args.help = true; continue; }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    args[key] = value;
  }
  return args;
}

export function requireArg(args, key) {
  if (!args[key]) throw new Error(`Missing --${key}`);
  return args[key];
}

export function sourceUrl({ url, html }) {
  if (Boolean(url) === Boolean(html)) throw new Error('Use exactly one of --url or --html.');
  return url || pathToFileURL(path.resolve(html)).href;
}

export function boxOf(value, label = 'box') {
  const box = Array.isArray(value) ? value : String(value).split(',').map(Number);
  if (box.length !== 4 || box.some(n => !Number.isFinite(n)) || box[0] < 0 || box[1] < 0 || box[2] <= 0 || box[3] <= 0) {
    throw new Error(`${label} must be x,y,width,height with positive width and height.`);
  }
  return box.map(Math.round);
}
