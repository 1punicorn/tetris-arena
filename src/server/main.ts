import 'dotenv/config';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { loadProfiles } from '../providers/config.js';
import { Manager } from './manager.js';
import { Artifacts } from './artifacts.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('PORT must be 1024..65535');
const manager = new Manager(new Artifacts(process.env.RESULTS_DIR ?? 'results'));
const config = process.env.CONNECTIONS_FILE ?? 'connections.local.json';
const app = createApp(manager, await loadProfiles(config), port, config);
const dev = import.meta.url.endsWith('.ts');
const vite = dev
  ? await (
      await import('vite')
    ).createServer({
      server: { middlewareMode: true, host: '127.0.0.1', hmr: false },
      appType: 'spa',
    })
  : null;
if (!dev) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
  app.get('*', serveStatic({ root }));
}
const api = getRequestListener(app.fetch);
const server = createServer((req, res) => {
  // Apply the same host/origin gate to Vite assets, not only APIs.
  const host = req.headers.host,
    origin = req.headers.origin;
  if (
    ![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(host ?? '') ||
    (origin && origin !== `http://${host}`) ||
    req.headers['sec-fetch-site'] === 'cross-site'
  ) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (vite && !req.url?.startsWith('/api/')) vite.middlewares(req, res);
  else void api(req, res);
});
server.listen(port, '127.0.0.1', () => console.log(`Tetris AI Bench: http://127.0.0.1:${port}`));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  await manager.close();
  await vite?.close();
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void close().then(() => process.exit(0));
  });
