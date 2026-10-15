import fs from 'node:fs/promises';
import { readyPage, readinessIssues } from './browser-ready.mjs';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import http from 'node:http';
import { requireDependency, resolveDependency, importDependency, sourceUrl } from './common.mjs';
import { collectDom } from './browser-inspect.mjs';
import { makeRepairPlan } from './repair-plan.mjs';

const require = createRequire(import.meta.url);
const sharp = require(resolveDependency('sharp'));
const { chromium } = requireDependency('playwright');
const { default: pixelmatch } = await importDependency('pixelmatch');

const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function validBox(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || box.some(n => !Number.isFinite(n))) return null;
  const [x, y, w, h] = box.map(Math.round);
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x >= width || y >= height) return null;
  return [x, y, Math.min(w, width - x), Math.min(h, height - y)];
}

function regionError(a, b, width, box) {
  const [x0, y0, w, h] = box;
  let total = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = (y * width + x) * 4;
    total += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return Math.round(1000 * total / (w * h * 3 * 255)) / 1000;
}

function splitVisualScores(target, render, width, height, inventory) {
  const mask = new Uint8Array(width * height);
  const differences = Buffer.alloc(width*height*4);
  pixelmatch(target,render,differences,width,height,{threshold:0.1,diffMask:true});
  const elements = new Map((inventory?.elements || []).map(item => [item.id, item]));
  const paint = (box, value) => {
    const valid = validBox(box, width, height);
    if (!valid) return;
    const [x, y, w, h] = valid;
    for (let row = y; row < y + h; row++) mask.fill(value, row * width + x, row * width + x + w);
  };
  for (const asset of inventory?.assets || []) if (['image', 'video', 'model3d'].includes(asset.kind)) paint(elements.get(asset.elementId)?.bounds, 1);
  for (const item of inventory?.elements || []) if (['text', 'control', 'icon'].includes(item.kind)) paint(item.bounds, 0);
  let layoutPixels = 0, mediaPixels = 0, layoutError = 0, mediaError = 0, layoutDifferent = 0, mediaDifferent = 0;
  for (let pixel = 0; pixel < mask.length; pixel++) {
    const offset = pixel * 4;
    const delta = Math.abs(target[offset] - render[offset]) + Math.abs(target[offset + 1] - render[offset + 1]) + Math.abs(target[offset + 2] - render[offset + 2]);
    if (mask[pixel]) { mediaPixels++; mediaError += delta; if (differences[offset+3]) mediaDifferent++; }
    else { layoutPixels++; layoutError += delta; if (differences[offset+3]) layoutDifferent++; }
  }
  const score = (pixels, error, different) => pixels ? { pixels, meanColorError: Math.round(1000 * error / (pixels * 765)) / 1000,
    differingFraction: Math.round(10000 * different / pixels) / 10000 } : null;
  return { layout: score(layoutPixels, layoutError, layoutDifferent), media: score(mediaPixels, mediaError, mediaDifferent),
    metric:'pixelmatch',threshold:0.1,includeAA:false,
    maskHash:crypto.createHash('sha256').update(mask).digest('hex'),
    note: 'Same pixelmatch threshold as the whole page. First-run masks stay fixed across repairs. Non-media pixels are not a structural quality score. Text and controls are retained even over media.' };
}

function regionsFromInventory(inventory, width, height) {
  const regions = (inventory?.regions || []).map(item => ({ id: item.id, bounds: validBox(item.bounds, width, height) })).filter(item => item.bounds);
  if (regions.length) return regions;
  const grid = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const x = Math.floor(col * width / 4), y = Math.floor(row * height / 4);
    grid.push({ id: `tile-${row}-${col}`, bounds: [x, y, Math.floor((col + 1) * width / 4) - x, Math.floor((row + 1) * height / 4) - y] });
  }
  return grid;
}

async function hashTree(directory) {
  const hash = crypto.createHash('sha256');
  async function visit(root) {
    for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        hash.update(path.relative(directory, file).replaceAll('\\', '/'));
        hash.update(await fs.readFile(file));
      }
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

export async function staticServer(html) {
  const root = path.dirname(path.resolve(html));
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.woff': 'font/woff', '.woff2': 'font/woff2' };
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); res.end(); return; }
    try {
      const bytes = await fs.readFile(file);
      res.writeHead(200, { 'content-type': `${mime[path.extname(file).toLowerCase()] || 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-store' });
      res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  return { server, url: `http://127.0.0.1:${server.address().port}/${path.basename(html)}` };
}

export class Evaluator {
  constructor({ target, url, html, out, inventoryPath, maxRuns = 3, browserPath, siteDir, allowSourceChange = false, siteProof, deadlineAt, softLimits = false }) {
    if (!target || !out) throw new Error('Use --target and --out.');
    this.targetPath = path.resolve(target);
    this.source = sourceUrl({ url, html });
    this.html = html ? path.resolve(html) : null;
    this.out = path.resolve(out);
    this.inventoryPath = inventoryPath ? path.resolve(inventoryPath) : null;
    this.maxRuns = Number(maxRuns);
    this.softLimits = softLimits;
    if (!Number.isInteger(this.maxRuns) || this.maxRuns < 1) throw new Error('--max-runs must be a positive integer.');
    this.browserPath = browserPath || process.env.CHROME_PATH || null;
    this.siteDir = siteDir ? path.resolve(siteDir) : null;
    this.siteProof = siteProof || null;
    this.allowSourceChange = allowSourceChange;
    this.deadlineAt = deadlineAt ? Date.parse(deadlineAt) : null;
    if (deadlineAt && !Number.isFinite(this.deadlineAt)) throw new Error('Invalid workflow deadline.');
    this.runCount = 0;
    this.best = null;
    this.running = false;
  }

  async open() {
    if (this.browser) return this;
    const previous = await fs.readFile(path.join(this.out, 'session.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (previous) {
      if (previous.target !== this.targetPath || previous.maxRuns !== this.maxRuns ||
          (!this.allowSourceChange && previous.source !== this.source))
        throw new Error('Existing session belongs to a different target, source, or run budget. Choose another --out directory.');
      this.previousSource = previous.source;
      this.runCount = previous.runCount;
      this.best = previous.best;
    }
    const meta = await sharp(this.targetPath).metadata();
    this.width = meta.width; this.height = meta.height;
    if (!this.width || !this.height) throw new Error('Target image has no dimensions.');
    this.targetRaw = await sharp(this.targetPath).ensureAlpha().raw().toBuffer();
    this.inventory = this.inventoryPath ? JSON.parse(await fs.readFile(this.inventoryPath, 'utf8')) : null;
    if (this.html) {
      const served = await staticServer(this.html);
      this.staticServer = served.server;
      this.liveSource = served.url;
    }
    const requestedBrowser = this.browserPath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const executablePath = await fs.access(requestedBrowser).then(() => requestedBrowser).catch(() => undefined);
    this.browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    this.context = await this.browser.newContext({ viewport: { width: this.width, height: this.height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    this.page = await this.context.newPage();
    return this;
  }

  status() { return { runCount: this.runCount, maxRuns: this.maxRuns, remaining: this.maxRuns - this.runCount,
    timeRemainingMinutes: this.deadlineAt == null ? null : Math.max(0, Math.round((this.deadlineAt - Date.now()) / 6000) / 10),
    best: this.best, source: this.source, target: this.targetPath }; }

  async run() {
    if (this.running) throw new Error('A capture is already running.');
    if (!this.softLimits && this.runCount >= this.maxRuns) throw new Error(`Run limit reached (${this.maxRuns}). Start a new session only with a deliberately larger budget.`);
    if (!this.softLimits && this.deadlineAt != null && Date.now() >= this.deadlineAt) throw new Error('Time budget reached for this workflow.');
    this.running = true;
    try {
      await this.open();
      const started = performance.now();
      await this.page.goto(this.liveSource || this.source, { waitUntil: 'domcontentloaded', timeout:10000 });
      if (this.siteProof) {
        const proofUrl = new URL(this.siteProof.path, this.source).href;
        const proofResponse = await this.page.request.get(proofUrl, { failOnStatusCode: false });
        const proof = proofResponse.ok() ? await proofResponse.json().catch(() => null) : null;
        if (proof?.token !== this.siteProof.token)
          throw new Error(`Candidate URL does not serve the bound site directory (${proofUrl}). Check the dev-server port and root.`);
      }
      const readiness = await readyPage(this.page);
      await this.page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
      const loadedMs = Math.round(performance.now() - started);
      const expected = (this.inventory?.elements || []).filter(item => typeof item.text === 'string' && item.text.trim()).map(item => ({ id: item.id, kind: item.kind, text: item.text, bounds: item.bounds }));
      const dom = await this.page.evaluate(expected => {
        const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
        const fieldText = [...document.querySelectorAll('input,textarea,select')].map(el => el.placeholder || el.value || el.textContent || '').join(' ');
        const allText = normalize(`${document.body.innerText} ${fieldText}`);
        return expected.map(item => {
          const node = document.querySelector(`[data-i2c-id="${CSS.escape(item.id)}"]`);
          const elementRect = node?.getBoundingClientRect();
          let textRect = null;
          if (node && (item.kind === 'text' || (item.kind === 'control' && node.matches('button,a,[role="button"]')))) {
            const range = document.createRange();
            range.selectNodeContents(node);
            const ink = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
            if (ink.length) {
              const left = Math.min(...ink.map(rect => rect.left));
              const top = Math.min(...ink.map(rect => rect.top));
              const right = Math.max(...ink.map(rect => rect.right));
              const bottom = Math.max(...ink.map(rect => rect.bottom));
              textRect = { x: left, y: top, width: right - left, height: bottom - top };
            }
          }
          const asBox = rect => rect ? [rect.x, rect.y, rect.width, rect.height].map(Math.round) : null;
          const elementBox = asBox(elementRect);
          const textBox = asBox(textRect);
          const distance = box => Array.isArray(item.bounds) && box
            ? box.reduce((sum, value, index) => sum + Math.abs(value - item.bounds[index]), 0) : Infinity;
          const useText = textBox && (item.kind === 'text' || (item.kind === 'control' && distance(textBox) < distance(elementBox)));
          const phrases = item.kind === 'container' ? item.text.split(',').map(normalize).filter(Boolean) : [normalize(item.text)];
          return { id: item.id, text: item.text, present: phrases.every(phrase => allText.includes(phrase)),
            actualBounds: useText ? textBox : elementBox, boundsSource: useText ? 'text' : 'element' };
        });
      }, expected);
      const pageHealth = await collectDom(this.page, { selector: 'body *', limit: 1 });
      this.runCount++;
      const runName = `run-${String(this.runCount).padStart(2, '0')}`;
      const runDir = path.join(this.out, runName);
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(this.out, 'session.json'), JSON.stringify(this.status(), null, 2) + '\n');
      const renderBytes = await this.page.screenshot({ animations: 'disabled', timeout:10000 });
      const capturedMs = Math.round(performance.now() - started);
      const renderRaw = await sharp(renderBytes).ensureAlpha().raw().toBuffer();
      if (renderRaw.length !== this.targetRaw.length) throw new Error('Render and target dimensions differ.');
      const diffRaw = Buffer.alloc(renderRaw.length);
      const overlayRaw = Buffer.alloc(renderRaw.length);
      let colorError = 0;
      for (let i = 0; i < renderRaw.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          colorError += Math.abs(this.targetRaw[i + c] - renderRaw[i + c]);
          overlayRaw[i + c] = Math.round((this.targetRaw[i + c] + renderRaw[i + c]) / 2);
        }
        overlayRaw[i + 3] = 255;
      }
      const differingPixels = pixelmatch(this.targetRaw, renderRaw, diffRaw, this.width, this.height, { threshold: 0.1 });
      const maskFile=path.join(this.out,'comparison-inventory.json');
      let comparisonInventory;
      try {comparisonInventory=JSON.parse(await fs.readFile(maskFile,'utf8'));}
      catch(error) {if(error.code!=='ENOENT') throw error; comparisonInventory=this.inventory;await fs.writeFile(maskFile,JSON.stringify(comparisonInventory));}
      const visualScores = splitVisualScores(this.targetRaw, renderRaw, this.width, this.height, comparisonInventory);
      const measuredMs = Math.round(performance.now() - started);
      const regions = regionsFromInventory(this.inventory, this.width, this.height).map(item => ({ ...item, meanColorError: regionError(this.targetRaw, renderRaw, this.width, item.bounds) })).sort((a, b) => b.meanColorError - a.meanColorError);
      const elementsById = new Map((this.inventory?.elements || []).map(item => [item.id, item]));
      const assetRegions = (this.inventory?.assets || []).map(asset => {
        const bounds = validBox(elementsById.get(asset.elementId)?.bounds, this.width, this.height);
        return bounds ? { id: asset.id, kind: asset.kind, bounds, meanColorError: regionError(this.targetRaw, renderRaw, this.width, bounds) } : null;
      }).filter(Boolean).sort((a, b) => b.meanColorError - a.meanColorError);
      const textChecks = dom.map(item => {
        const target = expected.find(entry => entry.id === item.id);
        const targetBounds = validBox(target.bounds, this.width, this.height);
        const boundsDelta = item.actualBounds && targetBounds ? item.actualBounds.map((value, index) => value - targetBounds[index]) : null;
        return { id: item.id, present: item.present, targetBounds, actualBounds: item.actualBounds, boundsSource: item.boundsSource, boundsDelta };
      });
      let sourceHash = null;
      if (this.siteDir) {
        const snapshot = path.join(runDir, 'source');
        await fs.cp(this.siteDir, snapshot, { recursive: true, filter: source => {
          const relative = path.relative(this.siteDir, source);
          return !relative.split(path.sep).some(part => ['node_modules', '.git', 'dist', '.next', 'build', 'coverage'].includes(part)) &&
            (!relative || !relative.startsWith('..'));
        } });
        sourceHash = await hashTree(snapshot);
      }
      const documentHash = crypto.createHash('sha256').update(await this.page.content()).digest('hex');
      await Promise.all([
        fs.writeFile(path.join(runDir, 'render.png'), renderBytes),
        sharp(diffRaw, { raw: { width: this.width, height: this.height, channels: 4 } }).png().toFile(path.join(runDir, 'diff.png')),
        sharp(overlayRaw, { raw: { width: this.width, height: this.height, channels: 4 } }).png().toFile(path.join(runDir, 'overlay.png')),
      ]);
      const topIssues = [
        ...(pageHealth.horizontalOverflow ? [{ type: 'horizontal-overflow', documentWidth: pageHealth.documentSize[0], viewportWidth: this.width }] : []),
        ...pageHealth.brokenImages.slice(0, 5).map(item => ({ type: 'broken-image', src: item.src })),
        ...textChecks.filter(item => !item.present).slice(0, 5).map(item => ({ type: 'missing-text', id: item.id })),
        ...textChecks.filter(item => item.boundsDelta && item.boundsDelta.some(value => Math.abs(value) > 8)).slice(0, 5).map(item => ({ type: 'geometry', id: item.id, boundsDelta: item.boundsDelta })),
        ...(visualScores.layout?.meanColorError > 0.05 ? [{ type: 'layout-visual', ...visualScores.layout }] : []),
        ...assetRegions.filter(item => item.kind === 'logo').slice(0, 2).map(item => ({ type: 'logo-visual', id: item.id, meanColorError: item.meanColorError })),
        ...(visualScores.media?.meanColorError > 0.05 ? [{ type: 'media-visual', ...visualScores.media }] : []),
        ...regions.slice(0, 3).map(item => ({ type: 'visual-region', id: item.id, meanColorError: item.meanColorError })),
      ];
      const report = {
        run: this.runCount, maxRuns: this.maxRuns, createdAt: new Date().toISOString(), target: this.targetPath, source: this.source,
        provenance: { previousSource: this.previousSource ?? null, documentHash, sourceHash,
          siteProofVerified: Boolean(this.siteProof), siteDir: this.siteDir, servedUrl: this.liveSource || this.source },
        viewport: { width: this.width, height: this.height }, differingPixels,
        visualScores, readiness, readinessIssues: readinessIssues(readiness),
        differingFraction: Math.round(10000 * differingPixels / (this.width * this.height)) / 10000,
        meanColorError: Math.round(1000 * colorError / (this.width * this.height * 3 * 255)) / 1000,
        regions: regions.slice(0, 12), assetRegions, textChecks, topIssues,
        pageHealth: { horizontalOverflow: pageHealth.horizontalOverflow, documentSize: pageHealth.documentSize,
          brokenImages: pageHealth.brokenImages, controls: pageHealth.controls, fonts: pageHealth.fonts },
        timingsMs: { loadAndAssets: loadedMs, capture: capturedMs - loadedMs, compare: measuredMs - capturedMs, total: Math.round(performance.now() - started) },
        note: 'Visual diagnostics at one viewport. Text geometry needs data-i2c-id attributes; functionality needs separate checks.',
      };
      await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      if (this.inventoryPath) {
        report.repairPlan = await makeRepairPlan({ reportFile: path.join(runDir, 'report.json'), inventoryFile: this.inventoryPath,
          remaining: this.maxRuns - this.runCount, timeRemainingMinutes: null });
        await fs.writeFile(path.join(runDir, 'repair-plan.json'), JSON.stringify(report.repairPlan, null, 2) + '\n');
        await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      }
      const selectionScore = visualScores.media
        ? Math.round(10000 * (0.75 * visualScores.layout.differingFraction + 0.25 * visualScores.media.differingFraction)) / 10000
        : visualScores.layout?.differingFraction ?? report.differingFraction;
      if (!this.best || selectionScore < (this.best.selectionScore ?? this.best.differingFraction)) this.best = { run: this.runCount, differingPixels,
        differingFraction: report.differingFraction, selectionScore, path: runDir };
      await fs.writeFile(path.join(this.out, 'session.json'), JSON.stringify(this.status(), null, 2) + '\n');
      return { ...report, runDir, best: this.best, remaining: this.maxRuns - this.runCount };
    } finally { this.running = false; }
  }

  async close() {
    await this.context?.close(); await this.browser?.close();
    if (this.staticServer) await new Promise(resolve => this.staticServer.close(resolve));
    this.context = null; this.browser = null; this.staticServer = null;
  }
}
