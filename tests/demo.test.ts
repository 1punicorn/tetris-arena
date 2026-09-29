import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, utimes, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createAccessPolicy } from '../src/server/access.js';
import { Runner } from '../src/core/runner.js';
import { RunConfigSchema } from '../src/core/run-config.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../src/server/settings-store.js';
import { Manager } from '../src/server/manager.js';
import { Artifacts } from '../src/server/artifacts.js';
import { createApp } from '../src/server/app.js';
import { createDemoMode } from '../src/server/demo.js';
import { ProfileSchema } from '../src/providers/config.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0)) await fn();
});
const profiles = ['a', 'b', 'c'].map((id) =>
  ProfileSchema.parse({
    id,
    name: id,
    model: `fixture/${id}`,
    provider: 'openai-compatible',
    baseURL: 'http://127.0.0.1:9/v1',
    reasoning: 'provider-default',
  }),
);
const headers = { host: '127.0.0.1:4317', 'content-type': 'application/json' };
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'tetris-demo-'));
  const store = new SettingsStore(join(dir, 'settings.sqlite'));
  const manager = new Manager(new Artifacts(join(dir, 'results')));
  cleanup.push(async () => {
    await manager.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const provider = store.saveProvider({
    name: 'Fixture',
    kind: 'openai-compatible',
    baseURL: 'http://127.0.0.1:9/v1',
  });
  const models = ['a', 'b', 'c'].map((id) =>
    store.saveModel(provider.id, { name: id, model: `fixture/${id}` }),
  );
  const demo = createDemoMode('fixture/a,fixture/b', store.profiles())!;
  const app = createApp(manager, store, 4317, undefined, demo);
  const send = (path: string, body: unknown = {}, method = 'POST') =>
    app.request(path, { method, headers, body: JSON.stringify(body) });
  return { dir, store, manager, provider, models, demo, app, send };
}

it('enables demos only for an explicit, unambiguous pair of available registered models', () => {
  expect(createDemoMode(undefined, profiles)).toBeNull();
  expect(createDemoMode(' ', profiles)).toBeNull();
  expect(createDemoMode(' a, fixture/b ', profiles)).toEqual({ models: ['a', 'b'] });
  for (const value of ['a', 'a,b,c', 'a,', 'a,a', 'a,fixture/a', 'a,unknown', 'human,b'])
    expect(() => createDemoMode(value, profiles)).toThrow('DEMO_MODELS');
  expect(() =>
    createDemoMode('fixture/a,b', [...profiles, { ...profiles[0], id: 'duplicate' }]),
  ).toThrow('DEMO_MODELS');
  expect(() =>
    createDemoMode('a,b', [{ ...profiles[0], apiKeyEnv: 'MISSING_DEMO_TEST_KEY' }, profiles[1]]),
  ).toThrow('DEMO_MODELS');
});

it('requires a demo for anonymous public access, while allowing normal local and authenticated use', async () => {
  const { store, manager, demo } = await setup();
  const access = createAccessPolicy(4317, {
    publicOrigin: 'https://demo.example.com',
    publicAccess: true,
  });
  expect(() => createApp(manager, store, 4317, access)).toThrow('requires valid DEMO_MODELS');
  expect(() => createApp(manager, store, 4317, access, demo)).not.toThrow();
  expect(() => createApp(manager, store, 4317)).not.toThrow();
  const protectedAccess = createAccessPolicy(4317, {
    publicOrigin: 'https://demo.example.com',
    username: 'owner',
    password: 'long-test-password',
  });
  expect(() => createApp(manager, store, 4317, protectedAccess)).not.toThrow();
});

it('exposes the fixed pair and blocks all alternate controls, settings writes and inference routes', async () => {
  const { app, store, manager, provider, models, demo, send } = await setup();
  const before = JSON.stringify([store.models(), store.providers(), store.experiment()]);
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
  const start = vi.spyOn(manager, 'start');
  const bench = vi.spyOn(manager, 'bench');
  const cancel = vi.spyOn(manager, 'cancel');
  expect(await (await app.request('/api/state', { headers })).json()).toMatchObject({
    demo,
    canStart: true,
  });
  const connections = await (await app.request('/api/connections', { headers })).json();
  expect(connections.map((model: any) => model.id)).toEqual(demo.models);
  for (const path of [
    '/api/bench',
    '/api/pause',
    '/api/cancel',
    '/api/action',
    '/api/settings/catalog',
    '/api/settings/providers',
    `/api/settings/providers/${provider.id}`,
    `/api/settings/registered-models/${models[0].id}/test`,
    '/api/settings/test',
    '/api/settings/models',
  ]) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect((await send(path, {}, method)).status, `${method} ${path}`).toBe(403);
  }
  for (const path of ['/api/settings', `/api/connections/${models[0].id}/models`]) {
    for (const method of ['GET', 'HEAD'])
      expect((await app.request(path, { method, headers })).status, `${method} ${path}`).toBe(403);
  }
  expect(external).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(bench).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(JSON.stringify([store.models(), store.providers(), store.experiment()])).toBe(before);
  expect(store.models()).toHaveLength(3);
});

it('accepts only empty start requests and uses fresh seeds with saved model and request settings', async () => {
  const { store, manager, demo, send } = await setup();
  store.saveExperiment({ ...store.experiment(), timeoutMs: 1234, attempts: 2 });
  const start = vi.spyOn(manager, 'start').mockImplementation((config) => ({ config }) as any);
  for (const body of [
    null,
    [],
    { players: demo.models },
    { players: [...demo.models].reverse() },
    { mode: 'decision' },
    { seed: 'fixed' },
    { timeoutMs: 120000 },
    { attempts: 5 },
    { maxSeconds: null },
    { maxTurns: 1 },
    { decisionStepMs: 0 },
    { modelOverrides: {} },
  ])
    expect((await send('/api/runs', body)).status).toBe(400);
  expect(start).not.toHaveBeenCalled();
  expect((await send('/api/runs')).status).toBe(201);
  expect((await send('/api/runs')).status).toBe(201);
  const [first, second] = start.mock.calls;
  expect(first[0]).toMatchObject({
    players: demo.models,
    mode: 'realtime',
    timeoutMs: 1234,
    attempts: 2,
    maxSeconds: null,
    maxTurns: null,
    modelOverrides: {},
  });
  expect(first[0].seed).not.toBe(second[0].seed);
  expect(first[1]).toEqual(store.profiles());
  expect(first[2]).toEqual(store.experiment());
});

it('shares one match, rejects concurrent starts and stays busy until recordings are flushed', async () => {
  const { dir, store, manager, demo, app, send } = await setup();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline fixture'));
  const responses = await Promise.all([send('/api/runs'), send('/api/runs')]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  const started = await responses.find((r) => r.status === 201)!.json();
  const state = async () => (await app.request('/api/state', { headers })).json();
  expect(await state()).toMatchObject({
    canStart: false,
    snapshot: { id: started.id, status: 'playing' },
  });
  expect(await state()).toMatchObject({ snapshot: { id: started.id } });
  for (const route of ['pause', 'cancel', 'action'])
    expect((await send(`/api/${route}`)).status).toBe(403);
  expect(manager.runner!.status).toBe('playing');
  const flush = manager.artifacts.flush.bind(manager.artifacts);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = vi.spyOn(manager.artifacts, 'flush').mockImplementation(async () => {
    await gate;
    await flush();
  });
  const observed: boolean[] = [];
  manager.on('state', () => {
    if (manager.runner?.status === 'finished') observed.push(manager.canStart);
  });
  const idle = once(manager, 'idle');
  manager.runner!.stop('top_out');
  expect(observed).toEqual([false]);
  expect(await state()).toMatchObject({ canStart: false, snapshot: { status: 'finished' } });
  expect((await send('/api/runs')).status).toBe(409);
  release();
  await idle;
  delayed.mockRestore();
  expect(observed).toEqual([false, true]);
  expect(await state()).toMatchObject({ canStart: true });
  const recovered = new Manager(new Artifacts(join(dir, 'results')));
  cleanup.push(() => recovered.close());
  const restarted = createApp(recovered, store, 4317, undefined, demo);
  expect(
    (await (await restarted.request('/api/results', { headers })).json()).map((s: any) => s.id),
  ).toContain(started.id);
  expect(
    (await restarted.request(`/api/results/${started.id}/events.jsonl`, { headers })).status,
  ).toBe(200);
  const next = await send('/api/runs');
  expect(next.status).toBe(201);
  expect((await next.json()).id).not.toBe(started.id);
});

it('sorts recordings by creation time regardless of file mtime and exposes read-only metadata', async () => {
  const { store, manager, models, demo, app } = await setup();
  const base = new Runner(
    RunConfigSchema.parse({ players: demo.models }),
    [null, null],
    () => {},
  ).snapshot();
  const ids: string[] = [];
  for (let i = 0; i < 32; i++) {
    const id = randomUUID();
    ids.push(id);
    manager.artifacts.metadata(id, store.profiles(), store.experiment());
    manager.artifacts.record({
      type: 'state',
      snapshot: { ...base, id, status: 'finished', reason: 'top_out' },
    });
    await manager.artifacts.flush();
    const time = new Date(1700000000000 + i * 1000);
    const metadataPath = join(manager.artifacts.root, id, 'metadata.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    await writeFile(metadataPath, JSON.stringify({ ...metadata, createdAt: time.toISOString() }));
    const reversedTime = new Date(1800000000000 - i * 1000);
    await utimes(join(manager.artifacts.root, id, 'summary.json'), reversedTime, reversedTime);
  }
  const hidden = randomUUID(),
    unfinished = randomUUID();
  manager.artifacts.record({
    type: 'state',
    snapshot: {
      ...base,
      id: hidden,
      status: 'finished',
      config: { ...base.config, players: [models[0].id, models[2].id] },
    },
  });
  manager.artifacts.record({
    type: 'state',
    snapshot: { ...base, id: unfinished, status: 'playing' },
  });
  await manager.artifacts.flush();
  const list = async (query = '') =>
    (await app.request(`/api/results${query}`, { headers })).json();
  expect((await list()).map((s: any) => s.id)).toEqual(ids.toReversed().slice(0, 30));
  expect((await list('?offset=30')).map((s: any) => s.id)).toEqual(ids.toReversed().slice(30));
  for (const query of ['?limit=101', '?offset=-1', '?offset=1.5'])
    expect((await app.request(`/api/results${query}`, { headers })).status).toBe(400);
  for (const id of [hidden, unfinished, randomUUID()])
    for (const file of ['summary.json', 'events.jsonl', 'metadata.json'])
      expect((await app.request(`/api/results/${id}/${file}`, { headers })).status).toBe(404);
  const meta = await (
    await app.request(`/api/results/${ids[0]}/metadata.json`, { headers })
  ).json();
  expect(meta.experiment).toEqual(store.experiment());
  expect((await list())[0].createdAt).toBe(new Date(1700000000000 + 31000).toISOString());
  expect(meta.connections.map((c: any) => c.id)).toEqual(demo.models);
  const exported = await (await app.request('/api/results.csv', { headers })).text();
  expect(exported).not.toContain(hidden);
  expect(exported).toContain(ids[0]);
  const normal = createApp(manager, store, 4317);
  expect((await (await normal.request('/api/results', { headers })).json()).length).toBe(33);
  expect(
    (await (await normal.request(`/api/results/${ids[0]}/metadata.json`, { headers })).json())
      .experiment,
  ).toEqual(store.experiment());
  expect((await normal.request('/api/settings/experiment', { headers })).status).toBe(200);
});

it('shows all saved demo settings with secrets redacted and previews without inference or writes', async () => {
  const { app, store, provider, models, send, demo } = await setup();
  store.saveProvider(
    {
      name: provider.name,
      kind: provider.kind,
      baseURL: provider.baseURL,
      apiKey: 'provider-secret-fixture',
    },
    provider.id,
  );
  const { id: _id, providerId: _providerId, ...modelInput } = models[0];
  store.saveModel(
    provider.id,
    {
      ...modelInput,
      providerOptions: { compatible: { headers: { authorization: 'options-secret-fixture' } } },
      requestBody: { custom: { api_key: 'body-secret-fixture' } },
    },
    models[0].id,
  );
  const privateProvider = store.saveProvider({
    kind: 'openai-compatible',
    name: 'Private provider',
    baseURL: 'http://localhost:9000/v1',
  });
  store.saveModel(privateProvider.id, { name: 'Private model', model: 'private/model' });
  const before = JSON.stringify([store.providers(), store.models(), store.experiment()]);
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
  const providers = await (await app.request('/api/settings/providers', { headers })).json();
  expect(providers).toHaveLength(1);
  expect(providers[0]).toMatchObject({
    id: provider.id,
    hasApiKey: true,
    modelCount: 2,
    enabledCount: 2,
  });
  for (const path of [
    `/api/settings/providers/${provider.id}/models`,
    '/api/settings/connections',
  ]) {
    const value = await (await app.request(path, { headers })).json();
    expect(value.map((m: any) => m.id)).toEqual(demo.models);
    expect(JSON.stringify(value)).not.toContain('secret-fixture');
    expect(value[0].requestBody.custom.api_key).toBe('[redacted]');
  }
  expect(
    (await app.request(`/api/settings/providers/${privateProvider.id}/models`, { headers })).status,
  ).toBe(404);
  expect(await (await app.request('/api/settings/experiment', { headers })).json()).toEqual(
    store.experiment(),
  );
  expect(JSON.stringify(providers)).not.toContain('secret-fixture');
  const preview = await send('/api/settings/preview', { modelId: models[0].id });
  expect(preview.status).toBe(200);
  const value = await preview.json();
  expect(value.body.model).toBe('fixture/a');
  expect(JSON.stringify(value)).not.toContain('secret-fixture');
  for (const input of [
    { modelId: models[2].id },
    { modelId: models[0].id, model: modelInput },
    { modelId: models[0].id, experiment: store.experiment() },
  ])
    expect((await send('/api/settings/preview', input)).status).toBe(403);
  expect(external).not.toHaveBeenCalled();
  expect(JSON.stringify([store.providers(), store.models(), store.experiment()])).toBe(before);
});

it('uses summary time for legacy recordings with missing or invalid creation metadata', async () => {
  const { manager, demo } = await setup();
  const base = new Runner(
    RunConfigSchema.parse({ players: demo.models }),
    [null, null],
    () => {},
  ).snapshot();
  manager.artifacts.record({ type: 'state', snapshot: { ...base, status: 'finished' } });
  await manager.artifacts.flush();
  const time = new Date('2026-09-01T04:30:00Z');
  await utimes(join(manager.artifacts.root, base.id, 'summary.json'), time, time);
  expect((await manager.artifacts.list())[0].createdAt).toBe(time.toISOString());
  await writeFile(
    join(manager.artifacts.root, base.id, 'metadata.json'),
    JSON.stringify({ createdAt: 'invalid' }),
  );
  expect((await manager.artifacts.list())[0].createdAt).toBe(time.toISOString());
});
