import { it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Manager } from '../src/server/manager.js';
import { Artifacts, csv } from '../src/server/artifacts.js';
import { createApp } from '../src/server/app.js';
import { ProfileSchema } from '../src/providers/config.js';
import { BenchConfigSchema, RunConfigSchema } from '../src/core/run-config.js';
import { SettingsStore } from '../src/server/settings-store.js';
const managers: Manager[] = [],
  stores: SettingsStore[] = [],
  dirs: string[] = [];
afterEach(async () => {
  for (const m of managers) await m.close();
  for (const store of stores) store.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  managers.length = 0;
  stores.length = 0;
  dirs.length = 0;
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'tetris-test-'));
  dirs.push(dir);
  const manager = new Manager(new Artifacts(dir));
  managers.push(manager);
  const store = new SettingsStore(join(dir, 'settings.sqlite'));
  stores.push(store);
  return { manager, dir, store, app: createApp(manager, store, 4317) };
}
it('blocks hostile hosts, cross-origin requests, non-JSON writes and oversized requests', async () => {
  const { app } = await setup();
  expect((await app.request('/api/state', { headers: { host: 'evil.example' } })).status).toBe(403);
  expect(
    (
      await app.request('/api/state', {
        headers: { host: '127.0.0.1:4317', origin: 'https://evil.example' },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request('/api/runs', {
        method: 'POST',
        headers: { host: '127.0.0.1:4317' },
        body: '{}',
      })
    ).status,
  ).toBe(415);
  expect(
    (
      await app.request('/api/runs', {
        method: 'POST',
        headers: { host: '127.0.0.1:4317', 'Content-Type': 'application/json' },
        body: ' '.repeat(32769),
      })
    ).status,
  ).toBe(413);
});
it('runs a match, persists a replay, exports CSV and rejects traversal', async () => {
  const { manager, dir } = await setup();
  const idle = once(manager, 'idle');
  const initial = manager.start(RunConfigSchema.parse({ mode: 'decision', maxTurns: 2 }), []);
  await idle;
  const summary = JSON.parse(await manager.artifacts.read(initial.id, 'summary.json'));
  expect(summary.turn).toBe(2);
  expect(summary.reason).toBe('turn_limit');
  const events = (await manager.artifacts.read(initial.id, 'events.jsonl'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(events.filter((e) => e.type === 'decision')).toHaveLength(4);
  expect(events.at(-1).snapshot).toEqual(summary);
  expect(csv([summary])).toContain('"draw"');
  const metadata = JSON.parse(await readFile(join(dir, initial.id, 'metadata.json'), 'utf8'));
  expect(metadata.promptHash).toMatch(/^[a-f0-9]{64}$/);
  await expect(manager.artifacts.read('../secrets', '.env')).rejects.toThrow('invalid_artifact');
});
it('runs a paired batch and flushes every summary before reporting idle', async () => {
  const { manager } = await setup();
  const idle = once(manager, 'idle');
  manager.bench(
    BenchConfigSchema.parse({
      models: ['heuristic', 'random'],
      seeds: ['1'],
      run: { mode: 'decision', maxTurns: 2 },
    }),
    [],
  );
  await idle;
  expect(manager.progress).toEqual({ total: 2, completed: 2, active: false });
  expect(await manager.artifacts.list()).toHaveLength(2);
});
it('never exposes credentials or provider options in the public catalog', async () => {
  const { store, app } = await setup();
  const p = ProfileSchema.parse({
    id: 'private',
    name: 'Private',
    provider: 'openai-compatible',
    baseURL: 'https://example.com/v1',
    model: 'model',
    apiKeyEnv: 'PRIVATE_KEY',
    apiKey: 'stored-private-key',
    providerOptions: { compatible: { user: 'private-identity' } },
  });
  const { id: _id, apiKeyEnv: _env, ...input } = p;
  store.save(input);
  const response = await app.request('/api/connections', { headers: { host: '127.0.0.1:4317' } });
  const body = await response.text();
  expect(body).not.toContain('PRIVATE_KEY');
  expect(body).not.toContain('stored-private-key');
  expect(body).not.toContain('private-identity');
  expect(body).not.toContain('baseURL');
});
it('rejects duplicate connections/invalid mode without starting a request', async () => {
  const { app, manager } = await setup();
  const response = await app.request('/api/runs', {
    method: 'POST',
    headers: { host: '127.0.0.1:4317', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'decision', players: ['human', 'random'] }),
  });
  expect(response.status).toBe(400);
  expect(manager.runner).toBeNull();
});

it('requires authentication for public routes, including SSE, without a spoofed local-host bypass', async () => {
  const { createAccessPolicy } = await import('../src/server/access.js');
  const { manager, store } = await setup();
  const password = 'test-password-only-123';
  const access = createAccessPolicy(4317, {
    publicOrigin: 'https://arena.example.com',
    username: 'owner',
    password,
  });
  const app = createApp(manager, store, 4317, access);
  for (const path of ['/api/health', '/api/events', '/api/state', '/']) {
    const response = await app.request(path, { headers: { host: 'arena.example.com' } });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Basic');
  }
  const authorization = 'Basic ' + Buffer.from(`owner:${password}`).toString('base64');
  expect(
    (
      await app.request('/api/health', {
        headers: { host: 'arena.example.com', authorization, origin: 'https://arena.example.com' },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request('/api/health', {
        headers: { host: 'arena.example.com', authorization, origin: 'https://attacker.test' },
      })
    ).status,
  ).toBe(403);
  expect((await app.request('/api/health', { headers: { host: '127.0.0.1:4317' } })).status).toBe(
    401,
  );
});

it('accepts an external document navigation but rejects cross-site API requests', async () => {
  const { app } = await setup();
  const navigation = {
    host: '127.0.0.1:4317',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  };
  const allowed = await app.request('/api/health', { headers: navigation });
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get('vary')).toContain('Sec-Fetch-Mode');
  expect(
    (
      await app.request('/api/state', {
        headers: { ...navigation, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request('/api/cancel', {
        method: 'POST',
        headers: { ...navigation, 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(403);
});
