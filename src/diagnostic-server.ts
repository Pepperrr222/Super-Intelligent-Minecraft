import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DiagnosticBus } from './diagnostics.js';

/** Loopback-only, read-only; no chat/action/credential endpoints. */
export async function startDiagnosticServer(bus: DiagnosticBus, options: { port?: number; assetPath?: string } = {}) {
  const html = readFileSync(options.assetPath ?? resolve('gui/diagnostics.html'));
  const server: Server = createServer((request, response) => {
    const address = server.address();
    const expected = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '';
    if (request.headers.host !== expected || request.headers.origin && request.headers.origin !== `http://${expected}`) {
      response.writeHead(403).end('Forbidden'); return;
    }
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
    if (request.method !== 'GET') { response.writeHead(405).end('Read only'); return; }
    const url = new URL(request.url ?? '/', `http://${expected}`);
    if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html); return; }
    if (url.pathname === '/api/events' || url.pathname === '/api/export') {
      const after = url.pathname === '/api/export' ? 0 : Number(url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) { response.writeHead(400).end('Invalid cursor'); return; }
      if (url.pathname === '/api/export') response.setHeader('Content-Disposition', 'attachment; filename="sim-diagnostics.json"');
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(bus.snapshot(after))); return;
    }
    response.writeHead(404).end('Not found');
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(options.port ?? 4318, '127.0.0.1', () => { server.removeListener('error', fail); ok(); }); });
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok())) };
}
