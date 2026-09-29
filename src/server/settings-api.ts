import { Hono } from 'hono';
import { z } from 'zod';
import { SettingsStore } from './settings-store.js';
import { ConnectionInputSchema } from '../providers/config.js';
import { ProviderInputSchema, ModelInputSchema, StoredModelSchema } from '../providers/registry.js';
import { discoverCatalog } from '../providers/catalog.js';
import { createAgent, discover, previewRequest } from '../providers/agents.js';
import { startGame } from '../core/engine.js';
import { random } from '../core/random.js';
import { buildCandidates } from '../core/ai-candidates.js';
import { makeProblem } from '../core/observation.js';
import { ExperimentSchema } from '../core/experiment.js';
import type { DemoMode } from './demo.js';

const draftSchema = z
  .object({ connectionId: z.string().optional(), profile: ConnectionInputSchema })
  .strict();
export function settingsApi(store: SettingsStore, demo: DemoMode | null = null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (
      demo &&
      c.req.method !== 'GET' &&
      !(c.req.method === 'POST' && c.req.path === '/api/settings/preview')
    )
      return c.json({ error: 'demo_settings_read_only' }, 403);
    await next();
  });
  app.get('/experiment', (c) => c.json(store.experiment()));
  app.put('/experiment', async (c) => c.json(store.saveExperiment(await c.req.json())));
  app.post('/preview', async (c) => {
    const input = z
      .object({
        modelId: z.string(),
        model: ModelInputSchema.optional(),
        experiment: ExperimentSchema.optional(),
        mode: z.enum(['decision', 'realtime']).default('decision'),
        duel: z.boolean().default(true),
      })
      .strict()
      .parse(await c.req.json());
    if (demo && (!demo.models.includes(input.modelId) || input.model || input.experiment))
      return c.json({ error: 'demo_settings_read_only' }, 403);
    const saved = store.model(input.modelId);
    const model = input.model
      ? StoredModelSchema.parse({ ...input.model, id: saved.id, providerId: saved.providerId })
      : saved;
    const profile = store.compile(store.provider(saved.providerId), model);
    const experiment = input.experiment ?? store.experiment();
    const game = startGame(random('request-preview'));
    const problem = makeProblem(
      game,
      input.duel ? game : undefined,
      buildCandidates(game),
      'request-preview',
      input.mode,
      experiment.prompts,
    );
    return c.json({ ...(await previewRequest(profile, problem)), mode: input.mode, sample: true });
  });
  app.get('/providers', (c) => {
    const models = demo ? store.models().filter((model) => demo.models.includes(model.id)) : null;
    return c.json(
      models
        ? store
            .providers()
            .filter((provider) => models.some((model) => model.providerId === provider.id))
            .map((provider) => ({
              ...provider,
              modelCount: models.filter((model) => model.providerId === provider.id).length,
              enabledCount: models.filter(
                (model) => model.providerId === provider.id && model.enabled,
              ).length,
            }))
        : store.providers(),
    );
  });
  app.post('/providers', async (c) => c.json(store.saveProvider(await c.req.json()), 201));
  app.put('/providers/:id', async (c) =>
    c.json(store.saveProvider(await c.req.json(), c.req.param('id'))),
  );
  app.delete('/providers/:id', (c) => {
    store.deleteProvider(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.get('/providers/:id/models', (c) => {
    store.provider(c.req.param('id'));
    const models = store.models(c.req.param('id'));
    return c.json(demo ? models.filter((model) => demo.models.includes(model.id)) : models);
  });
  app.put('/providers/:id/models', async (c) =>
    c.json(store.selectModels(c.req.param('id'), await c.req.json())),
  );
  app.post('/providers/:id/models', async (c) =>
    c.json(store.saveModel(c.req.param('id'), await c.req.json()), 201),
  );
  app.put('/registered-models/:id', async (c) => {
    const model = store.model(c.req.param('id'));
    return c.json(store.saveModel(model.providerId, await c.req.json(), model.id));
  });
  app.delete('/registered-models/:id', (c) => {
    store.delete(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/catalog', async (c) => {
    const { provider, providerId } = z
      .object({ provider: ProviderInputSchema, providerId: z.string().optional() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await discoverCatalog(
        store.draftProvider(provider, providerId),
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]),
      ),
    );
  });
  app.post('/registered-models/:id/test', async (c) => {
    const profile = store.get(c.req.param('id'));
    const game = startGame(random('connection-test'));
    const experiment = store.experiment();
    const problem = makeProblem(
      game,
      game,
      buildCandidates(game),
      'connection-test',
      'decision',
      experiment.prompts,
    );
    const result = await createAgent(profile.id, [profile], 'connection-test').decide(
      problem,
      AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(experiment.timeoutMs)]),
    );
    return c.json({ ok: true, model: result.model, latencyMs: Math.round(result.latencyMs) });
  });
  app.get('/connections', (c) =>
    c.json(store.list().filter((model) => !demo || demo.models.includes(model.id))),
  );
  app.post('/connections', async (c) => c.json(store.save(await c.req.json()), 201));
  app.put('/connections/:id', async (c) =>
    c.json(store.save(await c.req.json(), c.req.param('id'))),
  );
  app.delete('/connections/:id', (c) => {
    store.delete(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/connections/:id/duplicate', (c) => c.json(store.duplicate(c.req.param('id')), 201));
  app.post('/models', async (c) => {
    const { profile: input, connectionId } = draftSchema.parse(await c.req.json());
    const profile = store.draft(input, connectionId);
    return c.json(
      await discover(profile, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)])),
    );
  });
  app.post('/test', async (c) => {
    const { profile: input, connectionId } = draftSchema.parse(await c.req.json());
    const profile = store.draft(input, connectionId);
    const game = startGame(random('connection-test'));
    const experiment = store.experiment();
    const problem = makeProblem(
      game,
      game,
      buildCandidates(game),
      'connection-test',
      'decision',
      experiment.prompts,
    );
    const result = await createAgent(profile.id, [profile], 'connection-test').decide(
      problem,
      AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(experiment.timeoutMs)]),
    );
    return c.json({ ok: true, model: result.model, latencyMs: Math.round(result.latencyMs) });
  });
  return app;
}
