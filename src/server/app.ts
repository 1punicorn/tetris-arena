import { Hono } from 'hono';
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

export function createApp(
  manager: Manager,
  store: SettingsStore,
  port: number,
  access: AccessPolicy = createAccessPolicy(port),
) {
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
      maxSize:
        c.req.method === 'PUT' && /^\/api\/settings\/providers\/[^/]+\/models$/.test(c.req.path)
          ? 262144
          : 32768,
      onError: (c) => c.json({ error: 'request_too_large' }, 413),
    })(c, next),
  );
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
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
    error: manager.error,
  });
  const requireIdle = () => {
    if (manager.progress.active || (manager.runner && manager.runner.status !== 'finished'))
      throw new Error('run_in_progress');
  };
  const verifyOverrides = (overrides: Record<string, string>) => {
    if (Object.keys(overrides).some((id) => !store.profiles().some((p) => p.id === id)))
      throw new Error('unknown_model_override');
  };
  app.get('/api/health', (c) => c.json({ ok: true, version: '0.1.0' }));
  app.route('/api/settings', settingsApi(store));
  app.get('/api/connections', (c) => c.json([...baselines, ...store.publicModels()]));
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
    const config = RunConfigSchema.parse(await c.req.json());
    verifyOverrides(config.modelOverrides);
    return c.json(manager.start(config, store.profiles()), 201);
  });
  app.post('/api/bench', async (c) => {
    requireIdle();
    const config = BenchConfigSchema.parse(await c.req.json());
    verifyOverrides(config.run.modelOverrides);
    return c.json(manager.bench(config, store.profiles()), 201);
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
  app.get('/api/results', async (c) => c.json(await manager.artifacts.list()));
  app.get('/api/results.csv', async (c) => {
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="tetris-results.csv"');
    return c.body(csv(await manager.artifacts.list()));
  });
  app.get('/api/results/:id/:file', async (c) => {
    const file = c.req.param('file'),
      data = await manager.artifacts.read(c.req.param('id'), file);
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
