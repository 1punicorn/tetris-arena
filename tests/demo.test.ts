import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
  return { store, manager, provider, models, demo, app, send };
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

it('exposes only demo models while retaining other registered models in storage', async () => {
  const { app, store, provider, demo } = await setup();
  expect((await (await app.request('/api/state', { headers })).json()).demo).toEqual(demo);
  for (const path of [
    '/api/connections',
    '/api/settings/connections',
    `/api/settings/providers/${provider.id}/models`,
  ]) {
    const models = await (await app.request(path, { headers })).json();
    expect(models.map((model: any) => model.id)).toEqual(demo.models);
  }
  expect(await (await app.request('/api/settings/providers', { headers })).json()).toMatchObject([
    { modelCount: 2, enabledCount: 2 },
  ]);
  expect(store.models()).toHaveLength(3);
});

it('rejects every settings write and alternate inference route, but previews saved demo settings without inference', async () => {
  const { store, app, send, provider, models } = await setup();
  const before = JSON.stringify([store.models(), store.providers(), store.experiment()]);
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
  for (const [method, path] of [
    ['PUT', '/api/settings/experiment'],
    ['POST', '/api/settings/providers'],
    ['PUT', `/api/settings/providers/${provider.id}`],
    ['DELETE', `/api/settings/providers/${provider.id}`],
    ['PUT', `/api/settings/providers/${provider.id}/models`],
    ['POST', `/api/settings/providers/${provider.id}/models`],
    ['PUT', `/api/settings/registered-models/${models[0].id}`],
    ['DELETE', `/api/settings/registered-models/${models[0].id}`],
    ['POST', `/api/settings/registered-models/${models[2].id}/test`],
    ['POST', `/api/settings/registered-models/${models[0].id}/test`],
    ['POST', '/api/settings/catalog'],
    ['POST', '/api/settings/connections'],
    ['PUT', `/api/settings/connections/${models[0].id}`],
    ['DELETE', `/api/settings/connections/${models[0].id}`],
    ['POST', `/api/settings/connections/${models[0].id}/duplicate`],
    ['POST', '/api/settings/models'],
    ['POST', '/api/settings/test'],
  ])
    expect((await send(path, {}, method)).status, `${method} ${path}`).toBe(403);
  expect((await app.request(`/api/connections/${models[0].id}/models`, { headers })).status).toBe(
    403,
  );
  expect((await send('/api/settings/preview', { modelId: models[2].id })).status).toBe(403);
  expect(
    (await send('/api/settings/preview', { modelId: models[0].id, experiment: store.experiment() }))
      .status,
  ).toBe(403);
  const preview = await send('/api/settings/preview', { modelId: models[0].id });
  expect(preview.status).toBe(200);
  expect((await preview.json()).body.model).toBe('fixture/a');
  expect(external).not.toHaveBeenCalled();
  expect(JSON.stringify([store.models(), store.providers(), store.experiment()])).toBe(before);
});

it('pins arena and benchmark requests and rejects model overrides or other participants', async () => {
  const { manager, demo, models, send } = await setup();
  const start = vi.spyOn(manager, 'start').mockImplementation((config) => ({ config }) as any);
  const bench = vi.spyOn(manager, 'bench').mockImplementation((config) => ({ config }) as any);
  for (const players of [
    [models[0].id, models[2].id],
    [models[0].id, models[0].id],
    ['human', models[1].id],
    [models[0].id, 'none'],
    ['heuristic', 'random'],
  ])
    expect((await send('/api/runs', { players })).status).toBe(403);
  expect(
    (await send('/api/runs', { modelOverrides: { [models[0].id]: 'other-model' } })).status,
  ).toBe(403);
  for (const body of [
    { models: [models[0].id, models[2].id] },
    { run: { modelOverrides: { [models[1].id]: 'other-model' } } },
    { run: { players: ['heuristic', 'random'] } },
  ])
    expect((await send('/api/bench', body)).status).toBe(403);
  expect(start).not.toHaveBeenCalled();
  expect(bench).not.toHaveBeenCalled();
  expect((await send('/api/runs')).status).toBe(201);
  expect(start.mock.calls[0][0].players).toEqual(demo.models);
  expect((await send('/api/runs', { players: [...demo.models].reverse() })).status).toBe(201);
  expect((await send('/api/bench', { seeds: ['demo'], run: { maxTurns: 1 } })).status).toBe(201);
  expect(bench.mock.calls[0][0]).toMatchObject({
    models: demo.models,
    run: { mode: 'decision', maxTurns: 1, players: demo.models },
  });
});
