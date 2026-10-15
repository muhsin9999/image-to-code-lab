import http from 'node:http';
import { Evaluator } from './evaluator.mjs';

function reply(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value, null, 2) + '\n');
}

export async function startSession(options) {
  const evaluator = await new Evaluator(options).open();
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/status') return reply(res, 200, evaluator.status());
    if (req.method === 'POST' && pathname === '/compare') {
      try { return reply(res, 200, await evaluator.run()); }
      catch (error) { return reply(res, /Run limit|Time budget/.test(error.message) ? 429 : evaluator.running ? 409 : 500, { error: error.message, ...evaluator.status() }); }
    }
    if (req.method === 'POST' && pathname === '/close') {
      reply(res, 200, { closed: true, ...evaluator.status() });
      await evaluator.close();
      server.close();
      return;
    }
    reply(res, 404, { error: 'Use GET /status, POST /compare, or POST /close.' });
  });
  await new Promise((resolve, reject) => server.listen(Number(options.port ?? 0), '127.0.0.1', error => error ? reject(error) : resolve()));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  return { url, evaluator, server, close: async () => { await evaluator.close(); server.close(); } };
}
