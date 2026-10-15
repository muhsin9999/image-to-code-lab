import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requireDependency, resolveDependency, sourceUrl } from './common.mjs';

const require = createRequire(import.meta.url);
const sharp = require(resolveDependency('sharp'));
const { chromium } = requireDependency('playwright');

export async function collectDom(page, { selector = 'body *', limit = 400 } = {}) {
  if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 2000) throw new Error('--limit must be 1–2000.');
  return page.evaluate(({ selector, limit }) => {
    const nodes = [...document.querySelectorAll(selector)];
    const visible = nodes.filter(node => {
      const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden' && Number(css.opacity) > 0;
    });
    const rows = visible.slice(0, limit).map(node => {
      const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
      const ownText = [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent.trim()).filter(Boolean).join(' ').slice(0, 160);
      return { tag: node.tagName.toLowerCase(), id: node.getAttribute('data-i2c-id') || node.id || null,
        role: node.getAttribute('role') || null, text: ownText || null,
        bounds: [rect.x, rect.y, rect.width, rect.height].map(Math.round),
        font: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight,
        color: css.color, backgroundColor: css.backgroundColor,
        backgroundImage: css.backgroundImage === 'none' ? null : css.backgroundImage.slice(0, 300),
        src: node.currentSrc || node.getAttribute('src') || null,
        href: node.getAttribute('href') || null,
        label: node.getAttribute('aria-label') || null,
      };
    });
    const images = [...document.images].map(image => ({ src: image.currentSrc || image.src, loaded: image.complete && image.naturalWidth > 0,
      naturalSize: [image.naturalWidth, image.naturalHeight] }));
    const controls = [...document.querySelectorAll('button,input,select,textarea,a')].filter(node => {
      const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0;
    }).map(node => ({ tag: node.tagName.toLowerCase(), text: (node.innerText || node.value || node.getAttribute('aria-label') || '').trim().slice(0, 120),
      type: node.getAttribute('type'), bounds: [node.getBoundingClientRect().x, node.getBoundingClientRect().y,
        node.getBoundingClientRect().width, node.getBoundingClientRect().height].map(Math.round) }));
    return { viewport: [innerWidth, innerHeight], documentSize: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      visibleElementCount: visible.length, truncated: visible.length > limit, elements: rows,
      images, brokenImages: images.filter(image => !image.loaded), controls,
      fonts: [...new Set(visible.map(node => getComputedStyle(node).fontFamily))] };
  }, { selector, limit: Number(limit) });
}

export async function inspectBrowser({ target, width, height, url, html, selector, limit, browserPath }) {
  const source = sourceUrl({ url, html });
  let dimensions = [Number(width), Number(height)];
  if (target) {
    const meta = await sharp(path.resolve(target)).metadata();
    dimensions = [meta.width, meta.height];
  }
  if (dimensions.some(value => !Number.isInteger(value) || value < 1)) throw new Error('Use --target or positive --width and --height.');
  const requestedBrowser = browserPath || process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const executablePath = await fs.access(requestedBrowser).then(() => requestedBrowser).catch(() => undefined);
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: dimensions[0], height: dimensions[1] }, deviceScaleFactor: 1 });
    await page.goto(source, { waitUntil: 'load' });
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode().catch(() => {}))); });
    return { source, ...await collectDom(page, { selector, limit }) };
  } finally { await browser.close(); }
}
