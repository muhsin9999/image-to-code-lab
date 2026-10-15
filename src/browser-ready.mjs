// Readiness is bounded per resource group; time targets never disable commands.
export async function readyPage(page, { timeoutMs = 4000 } = {}) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(10000);
  return page.evaluate(async timeoutMs => {
    const settle = async promise => {
      let timer;
      try { return await Promise.race([promise.then(() => 'ready', () => 'failed'), new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); })]); }
      finally { clearTimeout(timer); }
    };
    // Offscreen lazy images otherwise wait forever for a viewport intersection.
    for (const img of document.images) img.loading = 'eager';
    const [fonts, images] = await Promise.all([
      settle(document.fonts.ready),
      settle(Promise.allSettled([...document.images].map(img => img.decode())))
    ]);
    return { fonts, images, failedImages: [...document.images].filter(img => !img.complete || !img.naturalWidth).map(img => img.getAttribute('src')) };
  }, timeoutMs);
}

export function readinessIssues(readiness) {
  return ['fonts', 'images'].filter(key => readiness[key] !== 'ready').map(key => ({
    kind: 'resource-readiness', id: key, severity: 'error', message: `${key} readiness ${readiness[key]}; comparison may be incomplete.`
  }));
}
