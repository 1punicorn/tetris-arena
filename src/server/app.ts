import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { redactParameters } from '../providers/model-settings.js';
import { basicAuth } from 'hono/basic-auth';
import { HTTPException } from 'hono/http-exception';
import { createAccessPolicy, REQUEST_VARY, type AccessPolicy } from './access.js';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { RunConfigSchema, BenchConfigSchema } from '../core/run-config.js';
import { safeError } from '../core/errors.js';
import { baselines } from '../providers/config.js';
import { discover } from '../providers/agents.js';
import { csv } from './artifacts.js';
import { Manager } from './manager.js';
import { SettingsStore } from './settings-store.js';
import { settingsApi } from './settings-api.js';
import { isDemoPair, type DemoMode } from './demo.js';

export function createApp(
  manager: Manager,
  store: SettingsStore,
  port: number,
  access: AccessPolicy = createAccessPolicy(port),
  demo: DemoMode | null = null,
) {
  if (access.publicHost && !access.needsAuthentication && !demo)
    throw new Error('PUBLIC_ACCESS=true requires valid DEMO_MODELS');
  const app = new Hono();
  const authenticate = access.needsAuthentication
    ? basicAuth({
        username: access.username!,
        password: access.password!,
        realm: 'Tetris AI Bench',
      })
    : null;
  app.use('*', async (c, next) => {
    c.header('Vary', REQUEST_VARY);
    const error = access.checkHeaders(
      c.req.header('host'),
      c.req.header('origin'),
      c.req.header('sec-fetch-site'),
      {
        method: c.req.method,
        mode: c.req.header('sec-fetch-mode'),
        destination: c.req.header('sec-fetch-dest'),
      },
    );
    if (error) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error }, 403);
    }
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    if (authenticate) {
      c.header('Cache-Control', 'no-store');
      return authenticate(c, next);
    }
    await next();
  });
  app.use('/api/*', (c, next) =>
    bodyLimit({
      maxSize: c.req.path.startsWith('/api/settings/') ? 262144 : 32768,
      onError: (c) => c.json({ error: 'request_too_large' }, 413),
    })(c, next),
  );
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (demo) {
      const read =
        ['GET', 'HEAD'].includes(c.req.method) &&
        (/^\/api\/(health|state|events|connections|results|results\.csv)$/.test(c.req.path) ||
          /^\/api\/settings\/(experiment|providers|connections)$/.test(c.req.path) ||
          /^\/api\/settings\/providers\/[a-zA-Z0-9_-]{1,64}\/models$/.test(c.req.path) ||
          /^\/api\/results\/[a-f0-9-]{36}\/(summary\.json|events\.jsonl|metadata\.json)$/.test(
            c.req.path,
          ));
      if (
        !read &&
        !(c.req.method === 'POST' && ['/api/runs', '/api/settings/preview'].includes(c.req.path))
      )
        return c.json({ error: 'demo_operation_not_allowed' }, 403);
    }
    if (
      ['POST', 'PUT', 'PATCH'].includes(c.req.method) &&
      !c.req.header('content-type')?.startsWith('application/json')
    )
      return c.json({ error: 'json_required' }, 415);
    await next();
  });
  const state = () => ({
    snapshot: manager.snapshot(),
    progress: manager.progress,
    benchmark: manager.benchmark,
    error: manager.error,
    canStart: manager.canStart,
    demo,
  });
  const requireIdle = () => {
    if (!manager.canStart) throw new Error(manager.error ?? 'run_in_progress');
  };
  const verifyOverrides = (overrides: Record<string, string>) => {
    if (Object.keys(overrides).some((id) => !store.profiles().some((p) => p.id === id)))
      throw new Error('unknown_model_override');
  };
  app.get('/api/health', (c) => c.json({ ok: true, version: '0.1.0' }));
  app.route('/api/settings', settingsApi(store, demo));
  app.get('/api/connections', (c) => {
    const models = store.publicModels();
    return c.json(
      demo
        ? demo.models.map((id) => models.find((model) => model.id === id)!)
        : [...baselines, ...models],
    );
  });
  app.get('/api/connections/:id/models', async (c) => {
    const profile = store.get(c.req.param('id'));
    return c.json(
      await discover(profile, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)])),
    );
  });
  app.get('/api/state', (c) => c.json(state()));
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let pending = Promise.resolve();
      const send = () => {
        pending = pending.then(() =>
          stream.writeSSE({ event: 'state', data: JSON.stringify(state()) }),
        );
        pending.catch(() => {});
      };
      manager.on('state', send);
      stream.onAbort(() => {
        manager.off('state', send);
      });
      send();
      try {
        while (!stream.aborted) {
          await stream.sleep(15000);
          if (!stream.aborted) await stream.writeSSE({ event: 'heartbeat', data: '{}' });
        }
      } finally {
        manager.off('state', send);
      }
    }),
  );
  app.post('/api/runs', async (c) => {
    requireIdle();
    const experiment = store.experiment();
    const raw = z.record(z.string(), z.unknown()).parse(await c.req.json());
    if (demo) z.object({}).strict().parse(raw);
    const config = RunConfigSchema.parse({
      timeoutMs: experiment.timeoutMs,
      attempts: experiment.attempts,
      ...(demo ? { players: demo.models, mode: 'realtime', seed: randomUUID() } : raw),
    });
    verifyOverrides(config.modelOverrides);
    return c.json(manager.start(config, store.profiles(), experiment), 201);
  });
  app.post('/api/bench', async (c) => {
    requireIdle();
    const experiment = store.experiment();
    const raw = z.record(z.string(), z.unknown()).parse(await c.req.json());
    const run = raw.run === undefined ? {} : z.record(z.string(), z.unknown()).parse(raw.run);
    const config = BenchConfigSchema.parse({
      ...raw,
      run: {
        mode: 'decision',
        timeoutMs: experiment.timeoutMs,
        attempts: experiment.attempts,
        ...run,
      },
    });
    verifyOverrides(config.run.modelOverrides);
    return c.json(manager.bench(config, store.profiles(), experiment), 201);
  });
  app.post('/api/pause', (c) => {
    manager.runner?.pause();
    return c.json(state());
  });
  app.post('/api/cancel', (c) => {
    manager.cancel();
    return c.json(state());
  });
  app.post('/api/action', async (c) => {
    const action = z
      .object({
        player: z.number().int().min(0).max(1),
        action: z.enum(['left', 'right', 'down', 'clockwise', 'counterclockwise', 'drop', 'hold']),
      })
      .strict()
      .parse(await c.req.json());
    manager.runner?.action(action.player, action.action);
    return c.json({ ok: true });
  });
  app.get('/api/results', async (c) => {
    const page =
      demo || Object.keys(c.req.query()).length
        ? z
            .object({
              limit: z.coerce.number().int().min(1).max(100).default(30),
              offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
            })
            .parse(c.req.query())
        : {};
    return c.json(await manager.artifacts.list({ ...page, models: demo?.models }));
  });
  app.get('/api/results.csv', async (c) => {
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="tetris-results.csv"');
    return c.body(csv(await manager.artifacts.list({ models: demo?.models })));
  });
  app.get('/api/results/:id/:file', async (c) => {
    if (demo) {
      const summary = await manager.artifacts
        .read(c.req.param('id'), 'summary.json')
        .then((data) => JSON.parse(data))
        .catch(() => null);
      if (summary?.status !== 'finished' || !isDemoPair(demo, summary.config.players))
        return c.json({ error: 'replay_unavailable' }, 404);
    }
    const file = c.req.param('file'),
      data = await manager.artifacts.read(c.req.param('id'), file);
    if (demo && file === 'metadata.json') {
      const metadata = JSON.parse(data);
      return c.json(
        redactParameters({
          ...metadata,
          connections: metadata.connections.filter((model: { id: string }) =>
            demo.models.includes(model.id),
          ),
        }),
      );
    }
    c.header('Content-Type', file.endsWith('jsonl') ? 'application/x-ndjson' : 'application/json');
    return c.body(data);
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 401) return error.getResponse();
    const code =
      error instanceof z.ZodError
        ? 'invalid_configuration'
        : error instanceof SyntaxError
          ? 'invalid_json'
          : [
                'run_in_progress',
                'unknown_model_override',
                'invalid_artifact',
                'artifact_too_large',
                'artifact_write_failed',
              ].includes(error.message)
            ? error.message
            : safeError(error);
    return c.json(
      {
        error: code,
        ...(error instanceof z.ZodError
          ? { fields: error.issues.map((issue) => issue.path.join('.')) }
          : {}),
      },
      code === 'run_in_progress' ? 409 : 400,
    );
  });
  return app;
}
