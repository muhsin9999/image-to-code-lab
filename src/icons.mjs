import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveDependency } from './common.mjs';

const require = createRequire(import.meta.url);
const packageFile = resolveDependency('lucide-static/package.json');
const iconRoot = path.join(path.dirname(packageFile), 'icons');
const tags = require(path.join(path.dirname(packageFile), 'tags.json'));

const words = text => String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export async function searchIcons(query, top = 12) {
  const tokens = words(query);
  if (!tokens.length) throw new Error('Give a visual or semantic icon query.');
  const files = await fs.readdir(iconRoot);
  return files.filter(file => file.endsWith('.svg')).map(file => {
    const name = file.slice(0, -4);
    const nameWords = words(name);
    const tagWords = (tags[name] || []).flatMap(words);
    const score = tokens.reduce((sum, token) => sum + (name === token ? 12 : nameWords.includes(token) ? 8 :
      nameWords.some(word => word.startsWith(token)) ? 4 : tagWords.includes(token) ? 2 : 0), 0);
    return { name, score, library: 'Lucide', path: path.join(iconRoot, file) };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, Math.max(1, Math.min(top, 30)));
}

export async function useIcon(name, out) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Icon name must be a Lucide icon ID.');
  if (path.extname(out).toLowerCase() !== '.svg') throw new Error('--out must end in .svg.');
  const source = path.join(iconRoot, `${name}.svg`);
  await fs.access(source).catch(() => { throw new Error(`Unknown Lucide icon: ${name}. Search first.`); });
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.copyFile(source, out);
  return { name, output: path.resolve(out), source, library: 'Lucide', license: 'ISC' };
}
