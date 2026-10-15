import fs from 'node:fs/promises';
import { readyPage, readinessIssues } from './browser-ready.mjs';
import { requireDependency } from './common.mjs';
import { staticServer } from './evaluator.mjs';

const { chromium } = requireDependency('playwright');

async function launch() {
  const requested = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '');
  const executablePath = requested && await fs.access(requested).then(() => requested).catch(() => undefined);
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

// Runs in the page. Compares like with like: ink width with ink width, baseline with baseline,
// first-glyph ink edge with the measured left edge. Fits font size (or letter spacing for tracked text).
export function fitInPage({ texts, others, allBoxes, adjust = true }) {
  const ctx = document.createElement('canvas').getContext('2d');
  const font = el => { const c = getComputedStyle(el); ctx.font = `${c.fontStyle} ${c.fontWeight} ${c.fontSize} ${c.fontFamily}`; ctx.letterSpacing = '0px'; return c; };
  const norm = t => String(t).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const sim = (a, b) => { a = norm(a).slice(0, 200); b = norm(b).slice(0, 200); if (!a && !b) return 1; if (!a || !b) return 0;
    const d = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
    return 1 - d[b.length] / Math.max(a.length, b.length); };
  // Rendered lines from text only (never element boxes): words grouped by line, with the true ink edges of the
  // first and last glyph and the baseline.
  const textLines = node => {
    const words = [];
    const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const el = n.parentElement;
      if (!el || !n.textContent.trim()) continue;
      const c = getComputedStyle(el);
      if (c.visibility === 'hidden' || c.display === 'none' || Number(c.opacity) === 0) continue;
      const re = /\S+/g; let m;
      while ((m = re.exec(n.textContent))) {
        const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
        const rect = [...r.getClientRects()].find(x => x.width > 0.5 && x.height > 0.5);
        // measure the glyphs as displayed: text-transform changes which letters are drawn
        const shown = c.textTransform === 'uppercase' ? m[0].toUpperCase() : c.textTransform === 'lowercase' ? m[0].toLowerCase()
          : c.textTransform === 'capitalize' ? m[0][0].toUpperCase() + m[0].slice(1) : m[0];
        if (rect) words.push({ n, el, start: m.index, text: shown, rect });
      }
    }
    const lines = [];
    for (const wd of words) {
      const l = lines.find(x => Math.abs(x.mid - (wd.rect.top + wd.rect.height / 2)) < Math.min(x.h, wd.rect.height) * 0.45);
      if (l) l.words.push(wd); else lines.push({ mid: wd.rect.top + wd.rect.height / 2, h: wd.rect.height, words: [wd] });
    }
    return lines.sort((a, b) => a.mid - b.mid).map(l => {
      l.words.sort((a, b) => a.rect.left - b.rect.left);
      const first = l.words[0], last = l.words.at(-1);
      const charRect = (wd, k) => { const r = document.createRange(); r.setStart(wd.n, wd.start + k); r.setEnd(wd.n, wd.start + k + 1); return r.getBoundingClientRect(); };
      font(first.el);
      const m0 = ctx.measureText(first.text[0]);
      const left = charRect(first, 0).left - m0.actualBoundingBoxLeft;
      const ascent = m0.fontBoundingBoxAscent;
      font(last.el);
      const k = last.text.length - 1;
      const right = charRect(last, k).left + ctx.measureText(last.text[k]).actualBoundingBoxRight;
      return { left, right, ink: right - left, baseline: first.rect.top + ascent, top: Math.min(...l.words.map(x => x.rect.top)),
        text: l.words.map(x => x.text).join(' '), chars: l.words.reduce((s, x) => s + x.text.length, 0), el: first.el };
    });
  };
  const clean = t => String(t || '').replace(/…/g, '').trim();
  const result = { overrides: [], missing: [], positions: [], wraps: [], stray: [], skipped: [], families: [], probes: [] };
  const fitted = [];
  for (const t of texts) {
    const node = document.querySelector(`[data-i2c-id="${CSS.escape(t.id)}"]`);
    if (!node) { result.missing.push(t.id); continue; }
    fitted.push({ t, node });
  }
  // fit every item first, then measure positions, so a fit that reflows the page is seen by all position checks
  for (const { t, node } of fitted) {
    if (!adjust || t.geometryTrusted === false) continue;
    const widestIndex = t.lines.reduce((best, l, i) => l.box[2] > t.lines[best].box[2] ? i : best, 0);
    const widest = t.lines[widestIndex];
    let changed = false;
    for (let pass = 0; pass < 5; pass++) {
      const lines = textLines(node);
      if (lines.length !== t.lines.length || t.partial || !clean(widest.text)) break;
      const line = lines[widestIndex];
      // only fit when the page shows the measured words; a fragment or wrong wording would give a wrong size
      // extra or missing glyphs at either end change the width directly, so the ends must agree too
      const edge = (v, i) => String(v).trim().at(i)?.toLowerCase();
      if (sim(line.text, widest.text) < 0.75 || edge(line.text, 0) !== edge(widest.text, 0) || edge(line.text, -1) !== edge(widest.text, -1)) { if (!pass) result.skipped.push(t.id); break; }
      if (!pass) (result.inkPairs ||= []).push({ id: t.id, target: widest.box[2], ink: Math.round(line.ink * 100) / 100, size: parseFloat(getComputedStyle(node).fontSize) });
      // measured ink widths miss the faint anti-aliased edge pixels: about 1.1px at every size (checker self-test, 656 lines)
      const target = widest.box[2] + 1.1;
      const ratio = target / line.ink;
      // a screenshot measures ink width to about ±1.5px; smaller differences are noise, and in flex rows a noise fit pushes the neighbours
      if (!Number.isFinite(ratio) || Math.abs(target - line.ink) <= Math.max(1.5, 0.008 * target)) break;
      const c = getComputedStyle(node);
      const size = parseFloat(c.fontSize), spacing = parseFloat(c.letterSpacing) || 0;
      // the page already uses the measured size but the measured width disagrees a lot: the facts contradict
      // each other (e.g. a bullet or icon counted into the width), so leave the size alone
      if (!pass && t.size && Math.abs(size / t.size - 1) < 0.04 && Math.abs(ratio - 1) > 0.1) { result.skipped.push(t.id); break; }
      if (t.spacing) node.style.setProperty('letter-spacing', `${Math.round(100 * (spacing + (target - line.ink) / Math.max(1, line.chars - 1))) / 100}px`, 'important');
      else node.style.setProperty('font-size', `${Math.round(100 * Math.min(size * 1.3, Math.max(size * 0.77, size * ratio))) / 100}px`, 'important');
      changed = true;
    }
    if (changed) {
      const c = getComputedStyle(node);
      result.overrides.push({ id: t.id, fontSize: c.fontSize, letterSpacing: c.letterSpacing === 'normal' ? '0px' : c.letterSpacing });
    }
  }
  for (const { t, node } of fitted) {
    if (node.matches('input,textarea,select')) continue; // placeholders/values have no DOM text nodes
    const lines = textLines(node);
    if (!lines.length) { result.missing.push(t.id); continue; }
    if (t.geometryTrusted !== false && lines.length !== t.lines.length) result.wraps.push({ id: t.id, rendered: lines.length, target: t.lines.length, targetWidth: Math.round(Math.max(...t.lines.map(l => l.box[2]))) });
    // the font that renders is read afterwards from the browser (checkFamilies); mark the element holding the first line
    if (t.family) { const el = lines[0].el; if (!el.hasAttribute('data-i2c-probe')) el.setAttribute('data-i2c-probe', t.id); result.probes.push({ id: t.id, key: el.getAttribute('data-i2c-probe'), want: t.family }); }
    const first = t.lines[0];
    // a position is only as good as the match: other words on the line mean another line or merged items (no position);
    // a different first character means OCR missed or added glyphs at the start (no left/right move)
    if (t.geometryTrusted === false || sim(lines[0].text, first.text) < 0.6) continue;
    const startsSame = String(lines[0].text).trim()[0]?.toLowerCase() === String(first.text).trim()[0]?.toLowerCase();
    result.positions.push({ id: t.id, dx: startsSame ? Math.round(lines[0].left - first.box[0]) : 0, dy: Math.round(lines[0].baseline - first.baseline) });
  }
  for (const o of others) {
    const node = document.querySelector(`[data-i2c-id="${CSS.escape(o.id)}"]`);
    if (!node) { result.missing.push(o.id); continue; }
    const r = node.getBoundingClientRect();
    const box = o.fileBox || o.box;
    result.positions.push({ id: o.id, dx: Math.round(r.left - box[0]), dy: Math.round(r.top - box[1]), dw: Math.round(r.width - box[2]), dh: Math.round(r.height - box[3]) });
  }
  // graphics that sit where the screenshot has nothing (e.g. an icon that lost its positioning)
  const hit = r => allBoxes.some(b => r.left < b[0] + b[2] + 6 && b[0] - 6 < r.right && r.top < b[1] + b[3] + 6 && b[1] - 6 < r.bottom);
  for (const el of document.querySelectorAll('img, svg, video, canvas, picture')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || el.closest('[data-i2c-id]')) continue;
    if (!hit(r)) result.stray.push({ tag: el.tagName.toLowerCase(), box: [r.left, r.top, r.width, r.height].map(Math.round) });
  }
  return result;
}

const SERIF = /serif|times|tinos|georgia|merriweather|playfair|lora|gelasio|garamond|baskerville|pt serif|noto serif|crimson|cormorant|dm serif|source serif|bodoni|didot|cambria|palatino|book antiqua|volkhov|slab/i;
const MONO = /mono|courier|cousine|consolas|menlo|monaco|code/i;
export const fontClass = name => MONO.test(name || '') ? 'mono' : SERIF.test(name || '') && !/sans/i.test(name) ? 'serif' : 'sans';

// The system font that actually draws each marked element's own text, as Chrome reports it (not the CSS name:
// a missing web font falls back silently). Returns { attributeValue: familyName }.
export async function renderedFonts(page, attr) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: `[${attr}]` });
    const out = {};
    for (const nodeId of nodeIds) {
      const { attributes } = await cdp.send('DOM.getAttributes', { nodeId });
      const key = attributes[attributes.indexOf(attr) + 1];
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId }).catch(() => ({ fonts: [] }));
      const best = [...fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0];
      if (best) out[key] = best.familyName;
    }
    return out;
  } finally { await cdp.detach().catch(() => {}); }
}

export async function checkFamilies(page, fit) {
  const used = await renderedFonts(page, 'data-i2c-probe');
  fit.families = fit.probes.filter(p => used[p.key] && fontClass(used[p.key]) !== fontClass(p.want))
    .map(p => ({ id: p.id, used: used[p.key], usedClass: fontClass(used[p.key]), want: p.want, wantClass: fontClass(p.want) }));
  return fit;
}

export function fitArgs(facts) {
  const items = facts.sections.flatMap(s => s.items);
  const texts = items.filter(i => i.type === 'text').map(i => ({ id: i.id, box: i.box, lines: i.lines, spacing: i.spacing, partial: i.partial, size: i.size, family: i.family, geometryTrusted: i.geometryTrusted }));
  const others = items.filter(i => ['box', 'image', 'icon', 'gradient'].includes(i.type))
    .map(i => ({ id: i.id, box: i.box, fileBox: i.type === 'icon' ? i.fileBox : null }));
  return { texts, others, allBoxes: items.map(i => i.fileBox || i.box) };
}

export async function fitPage({ html, facts, adjust = false }) {
  const { server, url } = await staticServer(html);
  const browser = await launch();
  try {
    const page = await (await browser.newContext({ viewport: facts.viewport, deviceScaleFactor: 1 })).newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout:10000 });
    await readyPage(page);
    const result = await checkFamilies(page, await page.evaluate(fitInPage, { ...fitArgs(facts), adjust }));
    // only text is required; untagged boxes, images and icons are checked when tagged
    const requiredText = new Set(facts.sections.flatMap(s => s.items).filter(i => i.type === 'text' && i.required !== false).map(i => i.id));
    result.missing = result.missing.filter(id => requiredText.has(id));
    return result;
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

export function fitCss(overrides) {
  return overrides.map(o => `[data-i2c-id="${o.id}"]{font-size:${o.fontSize}!important;letter-spacing:${o.letterSpacing}!important}`).join('\n') + '\n';
}
