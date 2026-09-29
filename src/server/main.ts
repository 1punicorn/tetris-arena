import 'dotenv/config';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Manager } from './manager.js';
import { Artifacts } from './artifacts.js';
import { createApp } from './app.js';
import { createAccessPolicy, REQUEST_VARY } from './access.js';
import { SettingsStore } from './settings-store.js';
import { createDemoMode } from './demo.js';

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('PORT must be 1024..65535');
const dev = import.meta.url.endsWith('.ts');
const access = createAccessPolicy(port, {
  host: process.env.HOST,
  publicOrigin: process.env.PUBLIC_ORIGIN,
  publicAccess: process.env.PUBLIC_ACCESS === 'true',
  username: process.env.PUBLIC_USERNAME,
  password: process.env.PUBLIC_PASSWORD,
  trustedProxyIP: process.env.TRUSTED_PROXY_IP,
});
if (dev && access.publicHost)
  throw new Error('Use pnpm build and pnpm start for public deployment');
const manager = new Manager(new Artifacts(process.env.RESULTS_DIR ?? 'results'));
const config = process.env.CONNECTIONS_FILE ?? 'connections.local.json';
const store = new SettingsStore(process.env.SETTINGS_DB ?? 'data/settings.sqlite');
await store.importLegacy(config);
const demo = createDemoMode(process.env.DEMO_MODELS, store.profiles());
const app = createApp(manager, store, port, access, demo);
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
  res.setHeader('Vary', REQUEST_VARY);
  // Protect both application routes and the local Vite development middleware.
  if (
    !access.allowsPeer(req.socket.remoteAddress) ||
    access.checkHeaders(
      req.headers.host,
      req.headers.origin,
      req.headers['sec-fetch-site'] as string | undefined,
      {
        method: req.method,
        mode: req.headers['sec-fetch-mode'] as string | undefined,
        destination: req.headers['sec-fetch-dest'] as string | undefined,
      },
    )
  ) {
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (vite && !req.url?.startsWith('/api/')) vite.middlewares(req, res);
  else void api(req, res);
});
server.listen(port, access.host, () =>
  console.log(`Tetris AI Bench: ${process.env.PUBLIC_ORIGIN ?? `http://${access.host}:${port}`}`),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  await manager.close();
  store.close();
  await vite?.close();
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void close().then(() => process.exit(0));
  });
