import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { SettingsStore } from '../src/server/settings-store.js';
import { createApp } from '../src/server/app.js';
import { createAccessPolicy } from '../src/server/access.js';
import { Manager } from '../src/server/manager.js';
import { Artifacts } from '../src/server/artifacts.js';
import { createAgent } from '../src/providers/agents.js';
import { startGame } from '../src/core/engine.js';
import { buildCandidates } from '../src/core/ai-candidates.js';
import { makeProblem } from '../src/core/observation.js';

const dirs: string[] = [],
  stores: SettingsStore[] = [],
  managers: Manager[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const manager of managers) await manager.close();
  for (const store of stores) store.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = stores.length = managers.length = servers.length = 0;
  vi.unstubAllEnvs();
});
const input = (extra = {}) => ({
  name: 'My model',
  provider: 'openai-compatible',
  baseURL: 'http://127.0.0.1:8000/v1',
  model: 'custom-model',
  reasoning: 'provider-default',
  apiKey: 'private-test-api-key',
  ...extra,
});
async function setup(publicAccess = false) {
  const dir = await mkdtemp(join(tmpdir(), 'tetris-settings-'));
  dirs.push(dir);
  const store = new SettingsStore(join(dir, 'settings.sqlite'));
  stores.push(store);
  const manager = new Manager(new Artifacts(join(dir, 'results')));
  managers.push(manager);
  const access = createAccessPolicy(
    4317,
    publicAccess ? { publicOrigin: 'https://arena.example.com', publicAccess: true } : {},
  );
  const app = createApp(manager, store, 4317, access);
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    app.request('/api' + path, {
      method,
      headers: {
        host: publicAccess ? 'arena.example.com' : '127.0.0.1:4317',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { dir, store, app, manager, request };
}

describe('persistent connection settings', () => {
  it('creates, edits, duplicates and deletes profiles without returning secrets', async () => {
    const { store, request } = await setup();
    const created = await request('/settings/connections', input());
    expect(created.status).toBe(201);
    const profile = await created.json();
    expect(profile).toMatchObject({
      model: 'custom-model',
      hasApiKey: true,
      credentialSource: 'saved',
    });
    expect(JSON.stringify(profile)).not.toContain('private-test-api-key');
    const edited = await request(
      `/settings/connections/${profile.id}`,
      input({ apiKey: undefined, model: 'another-model' }),
      'PUT',
    );
    expect(edited.status).toBe(200);
    expect(store.get(profile.id).apiKey).toBe('private-test-api-key');
    expect(store.get(profile.id).model).toBe('another-model');
    const duplicate = await (
      await request(`/settings/connections/${profile.id}/duplicate`, {})
    ).json();
    expect(duplicate.id).not.toBe(profile.id);
    expect(store.get(duplicate.id).apiKey).toBe('private-test-api-key');
    await request(
      `/settings/connections/${profile.id}`,
      input({ apiKey: undefined, clearApiKey: true }),
      'PUT',
    );
    expect(store.get(profile.id).apiKey).toBeUndefined();
    await request(
      `/settings/connections/${profile.id}`,
      input({ apiKey: 'rotated-test-key' }),
      'PUT',
    );
    expect(store.get(profile.id).apiKey).toBe('rotated-test-key');
    for (const path of ['/settings/connections', '/connections', '/state']) {
      const body = await (await request(path)).text();
      expect(body).not.toContain('private-test-api-key');
      expect(body).not.toContain('rotated-test-key');
    }
    expect((await request(`/settings/connections/${profile.id}`, undefined, 'DELETE')).status).toBe(
      200,
    );
    expect(() => store.get(profile.id)).toThrow('unknown_connection');
    expect(store.list()).toHaveLength(1);
  });

  it('persists the key and model across reopening the SQLite file with owner-only permissions', async () => {
    const { store } = await setup();
    const saved = store.save(input());
    const reopened = new SettingsStore(store.file);
    stores.push(reopened);
    expect(reopened.get(saved.id)).toMatchObject({
      model: 'custom-model',
      apiKey: 'private-test-api-key',
    });
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    for (const suffix of ['-wal', '-shm'])
      expect((await stat(store.file + suffix)).mode & 0o777).toBe(0o600);
  });

  it('imports legacy credentials once and does not resurrect deleted connections or depend on env afterwards', async () => {
    const { dir, store } = await setup();
    const legacy = join(dir, 'connections.json');
    vi.stubEnv('MIGRATION_TEST_KEY', 'imported-secret');
    await writeFile(
      legacy,
      JSON.stringify({
        connections: [
          { ...input({ apiKey: undefined }), id: 'legacy', apiKeyEnv: 'MIGRATION_TEST_KEY' },
        ],
      }),
    );
    await store.importLegacy(legacy);
    vi.stubEnv('MIGRATION_TEST_KEY', '');
    expect(store.get('legacy')).toMatchObject({ apiKey: 'imported-secret' });
    expect(store.get('legacy').apiKeyEnv).toBeUndefined();
    store.delete('legacy');
    const reopened = new SettingsStore(store.file);
    stores.push(reopened);
    await reopened.importLegacy(legacy);
    expect(reopened.list()).toEqual([]);
  });

  it('rejects invalid providers, URLs, unexpected secret selectors and broken options without changing saved data', async () => {
    const { request, store } = await setup();
    const saved = store.save(input());
    for (const update of [
      input({ provider: 'made-up' }),
      input({ baseURL: 'http://example.com/v1' }),
      input({ apiKeyEnv: 'ARBITRARY_SERVER_SECRET' }),
      input({ providerOptions: ['broken'] }),
      input({ baseURL: 'https://key:secret@example.com' }),
    ]) {
      expect((await request(`/settings/connections/${saved.id}`, update, 'PUT')).status).toBe(400);
    }
    expect(store.get(saved.id).apiKey).toBe('private-test-api-key');
    expect((await request('/connections/reload', {})).status).toBe(404);
    expect((await request('/settings/connections/missing', input(), 'PUT')).status).toBe(400);
  });

  it('uses saved credentials for discovery, a test decision, and a normal agent', async () => {
    let discoveries = 0,
      decisions = 0;
    const server = createServer(async (req, res) => {
      expect(req.headers.authorization).toBe('Bearer private-test-api-key');
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') {
        discoveries++;
        res.end(JSON.stringify({ data: [{ id: 'discovered-model' }] }));
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      expect(body.model).toBe('custom-model');
      decisions++;
      res.end(
        JSON.stringify({
          id: 'fixture',
          model: 'actual-model',
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '{"choice":"option_0"}' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
        }),
      );
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const { request, store } = await setup();
    const saved = store.save(input({ baseURL }));
    const draft = { connectionId: saved.id, profile: input({ baseURL, apiKey: undefined }) };
    const catalog = await request('/settings/models', draft);
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toContain('discovered-model');
    const tested = await request('/settings/test', draft);
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({ ok: true, model: 'actual-model' });
    const game = startGame(() => 0.5);
    const problem = makeProblem(game, game, buildCandidates(game), 'saved-profile', 'decision');
    const chosen = await createAgent(saved.id, store.profiles(), 'saved-profile').decide(
      problem,
      AbortSignal.timeout(2000),
    );
    expect(chosen.choice).toBe('option_0');
    expect(discoveries).toBe(1);
    expect(decisions).toBe(2);
  });

  it('allows public settings without administrator setup and never returns saved keys', async () => {
    const { store, request } = await setup(true);
    const created = await request('/settings/connections', input());
    expect(created.status).toBe(201);
    expect(created.headers.get('set-cookie')).toBeNull();
    const profile = await created.json();
    const listed = await request('/settings/connections');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([profile]);
    expect(profile.apiKey).toBeUndefined();
    expect(profile.hasApiKey).toBe(true);
    expect(store.get(profile.id).apiKey).toBe('private-test-api-key');
    expect((await request('/connections')).status).toBe(200);
    for (const path of ['/settings/session', '/settings/login', '/settings/logout'])
      expect((await request(path, {})).status).toBe(404);
    await expect(stat(`${store.file}.setup-code`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes legacy administrator credentials while preserving connections and migration state', async () => {
    const { store } = await setup();
    const profile = store.save(input());
    store.setSetting('owner_password', 'old-password-hash');
    store.setSetting('setup_hash', 'old-setup-hash');
    store.setSetting('legacy_imported', '1');
    const db = new DatabaseSync(store.file);
    try {
      db.exec(`
        CREATE TABLE sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
        INSERT INTO sessions VALUES ('old-session', 9999999999999);
      `);
      await writeFile(`${store.file}.setup-code`, 'obsolete-code', { mode: 0o600 });
      const reopened = new SettingsStore(store.file);
      stores.push(reopened);
      expect(reopened.get(profile.id)).toMatchObject({
        model: 'custom-model',
        apiKey: 'private-test-api-key',
      });
      expect(reopened.getSetting('legacy_imported')).toBe('1');
      expect(reopened.getSetting('owner_password')).toBeUndefined();
      expect(reopened.getSetting('setup_hash')).toBeUndefined();
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get(),
      ).toBeUndefined();
      await expect(stat(`${store.file}.setup-code`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      db.close();
    }
  });

  it('blocks cross-origin updates and non-JSON PUTs', async () => {
    const { app } = await setup(true);
    expect(
      (
        await app.request('/api/settings/connections/id', {
          method: 'PUT',
          headers: {
            host: 'arena.example.com',
            origin: 'https://attacker.test',
            'content-type': 'application/json',
          },
          body: JSON.stringify(input()),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/api/settings/connections/id', {
          method: 'PUT',
          headers: { host: 'arena.example.com' },
          body: '{}',
        })
      ).status,
    ).toBe(415);
  });
});

describe('shared providers and enabled models', () => {
  it('shares and rotates one credential, preserves model IDs and options when toggling, and cascades deletion', async () => {
    const { store, request } = await setup();
    const provider = await (
      await request('/settings/providers', {
        kind: 'openai',
        name: 'Shared OpenAI',
        apiKey: 'one-shared-secret',
      })
    ).json();
    expect(provider.baseURL).toBe('https://api.openai.com/v1');
    expect(provider.hasApiKey).toBe(true);
    const path = `/settings/providers/${provider.id}/models`;
    const selected = await (
      await request(path, { models: [{ model: 'alpha' }, { model: 'beta' }] }, 'PUT')
    ).json();
    expect(selected).toHaveLength(2);
    const alpha = selected.find((m: { model: string }) => m.model === 'alpha');
    const { id: _id, providerId: _providerId, ...alphaInput } = alpha;
    store.saveModel(
      provider.id,
      { ...alphaInput, name: 'My alpha', output: 'json-text' },
      alpha.id,
    );
    await request(path, { models: [{ model: 'beta' }] }, 'PUT');
    expect(store.profiles().map((p) => p.model)).toEqual(['beta']);
    expect(
      (await (await request('/connections')).json()).some((p: { id: string }) => p.id === alpha.id),
    ).toBe(false);
    expect(
      (await request('/runs', { players: [alpha.id, 'heuristic'], mode: 'decision', maxTurns: 1 }))
        .status,
    ).toBe(400);
    await request(path, { models: [{ model: 'alpha' }, { model: 'beta' }] }, 'PUT');
    expect(store.get(alpha.id)).toMatchObject({ name: 'My alpha', output: 'json-text' });
    await request(
      `/settings/providers/${provider.id}`,
      { kind: 'openai', name: 'Shared OpenAI', apiKey: 'rotated-shared-secret' },
      'PUT',
    );
    expect(store.profiles().every((p) => p.apiKey === 'rotated-shared-secret')).toBe(true);
    for (const route of ['/settings/providers', path, '/connections']) {
      const body = await (await request(route)).text();
      expect(body).not.toContain('one-shared-secret');
      expect(body).not.toContain('rotated-shared-secret');
    }
    const reopened = new SettingsStore(store.file);
    stores.push(reopened);
    expect(reopened.providers()).toHaveLength(1);
    expect(reopened.profiles()).toHaveLength(2);
    await request(`/settings/providers/${provider.id}`, undefined, 'DELETE');
    expect(store.models()).toEqual([]);
    expect(store.providers()).toEqual([]);
  });

  it('rolls back an invalid selection and rejects duplicate IDs and cross-provider edits', async () => {
    const { store, request } = await setup();
    const a = store.saveProvider({ kind: 'openai', name: 'A' }),
      b = store.saveProvider({ kind: 'anthropic', name: 'B' });
    const original = store.saveModel(a.id, { model: 'original', name: 'Original' });
    const path = `/settings/providers/${a.id}/models`;
    expect(
      (
        await request(
          path,
          { models: [{ model: 'good' }, { model: 'invalid', api: 'decisions' }] },
          'PUT',
        )
      ).status,
    ).toBe(400);
    expect(store.models(a.id)).toEqual([original]);
    expect(
      (await request(path, { models: [{ model: 'same' }, { model: 'same' }] }, 'PUT')).status,
    ).toBe(400);
    expect(() =>
      store.saveModel(b.id, { model: 'changed', name: 'Changed' }, original.id),
    ).toThrow();
    expect(store.models(a.id)).toEqual([original]);
    expect(
      (
        await request('/settings/providers', {
          kind: 'openai',
          name: 'A',
          apiKeyEnv: 'UNTRUSTED_SECRET',
        })
      ).status,
    ).toBe(400);
  });

  it('migrates a flat SQLite database into one shared provider without changing profile IDs or native APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tetris-migrate-'));
    dirs.push(dir);
    const file = join(dir, 'settings.sqlite');
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE connections (id TEXT PRIMARY KEY, profile TEXT NOT NULL); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('legacy_imported','1')",
    );
    const profiles = [
      {
        ...input({
          baseURL: 'https://openrouter.ai/api/v1',
          provider: 'openrouter-decisions',
          model: 'solar',
        }),
        id: 'solar-old',
        name: 'Solar',
      },
      {
        ...input({
          baseURL: 'https://openrouter.ai/api/v1/',
          model: 'deepseek',
          providerOptions: { openrouter: { reasoning: { enabled: false } } },
        }),
        id: 'deepseek-old',
      },
    ];
    for (const profile of profiles)
      db.prepare('INSERT INTO connections VALUES (?,?)').run(profile.id, JSON.stringify(profile));
    db.close();
    const store = new SettingsStore(file);
    stores.push(store);
    expect(store.providers()).toMatchObject([
      { kind: 'openrouter', enabledCount: 2, hasApiKey: true },
    ]);
    expect(store.get('solar-old')).toMatchObject({
      provider: 'openrouter-decisions',
      model: 'solar',
      apiKey: 'private-test-api-key',
    });
    expect(store.get('deepseek-old')).toMatchObject({
      provider: 'openai-compatible',
      model: 'deepseek',
      providerOptions: { openrouter: { reasoning: { enabled: false } } },
    });
    const inspect = new DatabaseSync(file);
    try {
      expect(
        inspect.prepare("SELECT name FROM sqlite_master WHERE name='connections'").get(),
      ).toBeUndefined();
      expect(inspect.prepare('SELECT config FROM providers').all()).toHaveLength(1);
      expect(JSON.stringify(inspect.prepare('SELECT config FROM models').all())).not.toContain(
        'private-test-api-key',
      );
    } finally {
      inspect.close();
    }
    const reopened = new SettingsStore(file);
    stores.push(reopened);
    expect(reopened.models()).toHaveLength(2);
    expect(reopened.getSetting('legacy_imported')).toBe('1');
  });
});

it('releases a disconnected browser subscription without waiting for the next heartbeat', async () => {
  const { request, manager } = await setup();
  const before = manager.listenerCount('state');
  const response = await request('/events');
  const reader = response.body!.getReader();
  await reader.read();
  expect(manager.listenerCount('state')).toBe(before + 1);
  await reader.cancel();
  expect(manager.listenerCount('state')).toBe(before);
});
