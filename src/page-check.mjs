import fs from 'node:fs/promises';
import { readyPage, readinessIssues } from './browser-ready.mjs';
import path from 'node:path';
import { requireDependency } from './common.mjs';
import { staticServer } from './evaluator.mjs';

import { inspectComponents, inspectDisclosures } from './component-check.mjs';

const { chromium } = requireDependency('playwright');

// Shared by the checker and behavioral tests. Uses real browser layout, not CSS string matching.
export async function inspectUsability(page, { expected = [], reference = false } = {}) {
  return page.evaluate(({ expected, reference }) => {
    const issues = [], seen = new Set();
    const norm = v => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const add = (kind, id, message, severity = 'error') => {
      const key = `${kind}:${id}`;
      if (!seen.has(key)) { issues.push({ kind, id, message, severity }); seen.add(key); }
    };
    const label = e => e.getAttribute('data-i2c-id') || e.id || e.tagName.toLowerCase();
    const visible = e => {
      if (!e.getClientRects().length) return false;
      for (let a = e; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      }
      return true;
    };
    const visibleText = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), parts = [];
      let node;
      while ((node = walker.nextNode())) if (!node.parentElement.closest('script,style') && visible(node.parentElement)) parts.push(node.textContent);
      for (const e of document.querySelectorAll('input,textarea,select')) if (visible(e)) parts.push(e.value || e.placeholder || e.textContent);
      return norm(parts.join(' '));
    };
    const text = visibleText();
    if (document.documentElement.scrollWidth > innerWidth + 2) add('overflow', 'page', `Page width ${document.documentElement.scrollWidth}px exceeds viewport ${innerWidth}px.`);
    for (const image of document.images) if (visible(image) && (!image.complete || !image.naturalWidth)) add('broken-image', label(image), `Image failed to load: ${image.getAttribute('src')}`);
    for (const t of expected) {
      const node = document.querySelector(`[data-i2c-id="${CSS.escape(t.id)}"]`);
      // An equivalent menu may replace navigation at smaller sizes. Preserve page content, allow explicitly marked alternate controls.
      if (!reference && t.responsiveOptional) continue;
      if (t.uncertain) continue;
      const wanted = norm(t.text);
      if (wanted && !text.includes(wanted)) add('missing-content', t.id, `Expected visible wording is absent: ${t.text.slice(0, 100)}`);
      if (node && !visible(node)) add('hidden-content', t.id, 'Tagged content is hidden; check the intended responsive alternative.');
    }
    const checkNodes = [...document.querySelectorAll('[data-i2c-id],h1,h2,h3,nav a,button,input,textarea,select')];
    for (const el of checkNodes) {
      if (!visible(el)) continue;
      const id = label(el), rect = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (!rect.width || !rect.height) continue;
      if (rect.right > innerWidth + 2 || rect.left < -2) {
        let scrollable = false;
        for (let a = el.parentElement; a; a = a.parentElement) if (['auto', 'scroll'].includes(getComputedStyle(a).overflowX) && a.scrollWidth > a.clientWidth) scrollable = true;
        if (!scrollable) add('offscreen', id, 'Content extends beyond the visible page width.');
      }
      if ((el.textContent.trim() || el.matches('input,textarea')) && parseFloat(style.fontSize) < 10) add('small-text', id, `Text is ${style.fontSize}; inspect readability.`, 'warning');
      if (['hidden', 'clip'].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 2) add('clipped-content', id, 'Content is clipped inside its own box.');
      for (let ancestor = el.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const a = getComputedStyle(ancestor), r = ancestor.getBoundingClientRect();
        if ((['hidden', 'clip'].includes(a.overflowX) && (rect.left < r.left - 2 || rect.right > r.right + 2)) ||
            (['hidden', 'clip'].includes(a.overflowY) && (rect.top < r.top - 2 || rect.bottom > r.bottom + 2))) {
          add('clipped-content', id, 'An ancestor clips this content.'); break;
        }
      }
      // Probe actual text glyphs after scrolling; avoids calling an empty transparent wrapper "covered".
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n, glyph;
      while ((n = walker.nextNode())) { const at = n.textContent.search(/\S/); if (at >= 0) { const range = document.createRange(); range.setStart(n, at); range.setEnd(n, at + 1); const r = range.getBoundingClientRect(); if (r.width && r.height) { glyph = range; break; } } }
      if (!glyph && !el.matches('input,button,select,textarea')) continue;
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const r = glyph ? glyph.getBoundingClientRect() : el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) continue;
      const stack = document.elementsFromPoint(x, y);
      for (const top of stack) {
        if (top === el || el.contains(top) || top.contains(el)) break;
        const c = getComputedStyle(top), color = c.backgroundColor;
        const opaque = color.startsWith('rgb(') || /rgba\([^)]*,\s*1\s*\)/.test(color);
        if (Number(c.opacity) > 0.95 && (opaque || c.backgroundImage !== 'none' || top.matches('img,video,canvas'))) {
          add('covered-content', id, `Content appears covered by ${label(top)}. Inspect stacking and container positions.`); break;
        }
      }
    }
    scrollTo(0, 0);
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, issues };
  }, { expected, reference });
}

export async function checkViewports({ html, facts, runDir, verifyWording = true }) {
  const requested = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);
  const executablePath = requested && await fs.access(requested).then(() => requested).catch(() => undefined);
  const { server, url } = await staticServer(html);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const expected = (verifyWording ? facts.sections : []).flatMap(s => s.items).filter(i => i.type === 'text' && i.required !== false).map(i => ({ id: i.id,
      text: i.reviewedText || i.lines.map(l => l.text).join(' '), uncertain: !i.reviewedText && (i.partial || i.ocrConfidence < .75),
      responsiveOptional: /navigation|menu/.test(i.role || '') }));
    const results = [];
    const probe = await browser.newPage();
    await probe.goto(url, { waitUntil: 'domcontentloaded', timeout:10000 });
    const discovered = await probe.evaluate(() => {
      const widths = new Set();
      const visit = rules => { for (const r of rules) { if (r.media) for (const match of r.media.mediaText.matchAll(/(?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)px/g)) widths.add(Math.round(Number(match[1]))); if (r.cssRules) visit(r.cssRules); } };
      for (const sheet of document.styleSheets) { try { visit(sheet.cssRules); } catch {} }
      return [...widths];
    });
    await probe.close();
    const breakpoints = [...new Set([...(facts.review?.breakpoints || []), ...discovered])].filter(w => w >= 240 && w <= 3840);
    const selectedBreakpoints = breakpoints.slice(0, 4);
    const baseWidths = [facts.viewport.width, 768, 390];
    const widths = [...new Set([...baseWidths, ...selectedBreakpoints.flatMap(w => [w - 1, w + 1])])];
    await fs.writeFile(path.join(runDir,'responsive.json'),'[]');
    await fs.writeFile(path.join(runDir,'viewport-coverage.json'),JSON.stringify({widths,completedWidths:[],status:'in-progress'},null,2));
    for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: width === facts.viewport.width ? facts.viewport.height : 900 }, deviceScaleFactor: 1 });
      const runtimeErrors = [];
      page.on('pageerror', error => runtimeErrors.push(error.message));
      try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout:10000 });
      const readiness = await readyPage(page);
      const result = await inspectUsability(page, { expected, reference: width === facts.viewport.width });
      result.readiness = readiness;
      result.issues.push(...readinessIssues(readiness));
      result.components = await inspectComponents(page, facts);
      result.issues.push(...result.components.issues);
      result.disclosures = await inspectDisclosures(page);
      result.issues.push(...result.disclosures.issues);
      result.status = readinessIssues(readiness).length ? "incomplete" : "complete";
      result.wordingVerified = verifyWording;
      result.checkType = baseWidths.includes(width) ? 'base' : 'breakpoint-boundary';
      const controls = await page.evaluate(() => ({ placeholderLinks: [...document.querySelectorAll('a')].filter(a => !a.getAttribute('href') || ['#','#top'].includes(a.getAttribute('href'))).length,
        forms: document.forms.length }));
      result.interactions = { declared: facts.review?.interactions?.length || 0, tested: [], ...controls };
      if (controls.placeholderLinks) result.issues.push({ kind: 'placeholder-link', id: 'page', message: `${controls.placeholderLinks} links have no destination; verify intended behavior.`, severity: 'warning' });
      for (const interaction of facts.review?.interactions || []) {
        if (Array.isArray(interaction.widths) && !interaction.widths.includes(width)) continue;
        try {
          if (!interaction.selector || !['click','fill'].includes(interaction.action) || !interaction.expect || typeof interaction.expect !== 'object') throw new Error('Interaction needs selector, action click/fill and an expect object.');
          await page.goto(url, {waitUntil:'domcontentloaded',timeout:10000});
          const el=page.locator(interaction.selector).first();
          if(interaction.action==='fill') await el.fill(String(interaction.value ?? ''),{timeout:1500});
          else await el.click({timeout:1500});
          const expectation=interaction.expect, target=page.locator(expectation.selector || interaction.selector).first();
          if (!['visible','text','value','hash'].some(k => expectation[k] !== undefined)) throw new Error('Specify visible, text, value or hash expectation.');
          if (expectation.visible !== undefined) {if(expectation.visible) await target.waitFor({state:'visible',timeout:1500});else await target.waitFor({state:'hidden',timeout:1500});}
          if (expectation.text !== undefined) await page.waitForFunction(({selector,text}) => document.querySelector(selector)?.textContent.includes(text), {selector:expectation.selector || interaction.selector,text:expectation.text},{timeout:1500});
          if (expectation.value !== undefined && await target.inputValue() !== expectation.value) throw new Error('Value does not match expectation.');
          if (expectation.hash !== undefined && new URL(page.url()).hash !== expectation.hash) throw new Error('Destination hash does not match expectation.');
          result.interactions.tested.push({selector:interaction.selector,status:'passed'});
        } catch(error) {
          result.interactions.tested.push({selector:interaction.selector,status:'failed',message:error.message});
          result.issues.push({kind:'interaction-failed',id:interaction.selector || 'unknown',message:error.message,severity:'error'});
        }
      }
      // Captures show the initial visual state, independent of interaction mutations.
      if (facts.review?.interactions?.length || result.disclosures.tested.length) {
        await page.goto(url,{waitUntil:'domcontentloaded',timeout:10000});
        await readyPage(page);
      }
      for (const message of runtimeErrors) result.issues.push({ kind: 'runtime-error', id: 'page', message, severity: 'error' });
      if (width !== facts.viewport.width && baseWidths.includes(width)) {
        result.render = `viewport-${width}.png`;
        await page.screenshot({ path: path.join(runDir, result.render), fullPage: true, animations: 'disabled', timeout:10000 });
      }
      results.push(result);
      } catch(error) { results.push({width,status:'incomplete',issues:[{kind:'verification-incomplete',id:'page',severity:'error',message:error.message}]}); }
      finally { await page.close(); }
      await fs.writeFile(path.join(runDir, 'responsive.json'), JSON.stringify(results,null,2));
      await fs.writeFile(path.join(runDir, 'viewport-coverage.json'), JSON.stringify({widths,completedWidths:results.map(r=>r.width),status:results.length===widths.length?'complete':'in-progress'},null,2));
    }
    await fs.writeFile(path.join(runDir, 'responsive.json'), JSON.stringify(results, null, 2));
    await fs.writeFile(path.join(runDir, 'viewport-coverage.json'), JSON.stringify({ status:results.every(r=>r.status==='complete')?'complete':'incomplete', widths, completedWidths:results.map(r=>r.width), detectedBreakpoints:breakpoints, selectedBreakpoints, skippedBreakpoints:breakpoints.slice(4), note:'Up to four breakpoint pairs are sampled. This is not an exhaustive width or interaction certification.' },null,2));
    return results;
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
