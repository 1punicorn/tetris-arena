import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

let fixture: Server;
let providerId: string;
let hold = false;
const waiting = new Set<() => void>();
const release = () => {
  hold = false;
  for (const fn of waiting) fn();
  waiting.clear();
};
test.beforeAll(async ({ request }) => {
  fixture = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (hold)
      await new Promise<void>((resolve) => {
        const done = () => {
          waiting.delete(done);
          resolve();
        };
        waiting.add(done);
        res.once('close', done);
      });
    if (res.destroyed) return;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'benchmark-fixture',
        model: body.model,
        created: 1,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '{"choice":"option_0"}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  providerId = (
    await (
      await request.post('/api/settings/providers', {
        data: {
          name: 'Benchmark fixture',
          kind: 'openai-compatible',
          baseURL: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`,
        },
      })
    ).json()
  ).id;
  await request.put(`/api/settings/providers/${providerId}/models`, {
    data: {
      models: [
        { model: 'bench-alpha', name: 'Bench Alpha' },
        { model: 'bench-beta', name: 'Bench Beta' },
      ],
    },
  });
});
test.afterEach(async ({ request }) => {
  await request.post('/api/cancel', { data: {} });
  release();
});
test.afterAll(async ({ request }) => {
  await request.delete(`/api/settings/providers/${providerId}`);
  release();
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
});

test('runs a batch in its own tab, restores progress after reload and opens the live match from replay', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // An earlier result supplies a replay while the new batch keeps running.
  await request.post('/api/runs', { data: { mode: 'decision', maxTurns: 1, decisionStepMs: 0 } });
  await expect
    .poll(async () => (await (await request.get('/api/state')).json()).snapshot.status)
    .toBe('finished');
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start match', exact: true })).toBeEnabled();
  await page.getByLabel('Run limit', { exact: true }).fill('9');
  await expect(page.getByRole('button', { name: 'Benchmark models', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Benchmark', exact: true }).click();
  await expect(page.getByLabel('Benchmark mode', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Benchmark run limit', { exact: true })).toHaveValue('');
  await page.getByLabel('Benchmark seeds', { exact: true }).fill('seed-one, seed-two');
  await page.getByLabel('Benchmark run limit', { exact: true }).fill('1');
  await expect(page.locator('.benchmark-launch strong')).toHaveText('4 matches');
  await page.getByRole('link', { name: 'Arena', exact: true }).click();
  await expect(page.getByLabel('Mode', { exact: true })).toHaveValue('realtime');
  await expect(page.getByLabel('Run limit', { exact: true })).toHaveValue('9');
  await page.getByRole('link', { name: 'Benchmark', exact: true }).click();
  await expect(page.getByLabel('Benchmark run limit', { exact: true })).toHaveValue('1');
  hold = true;
  await page.getByRole('button', { name: 'Run benchmark', exact: true }).click();
  await expect(page.locator('.benchmark-status')).toHaveText('Running');
  await expect(page.locator('.benchmark-current')).toContainText('Bench Alpha');
  await expect(page.locator('.benchmark-count')).toContainText('0 / 4');
  await page.reload();
  await expect(page.getByRole('link', { name: 'Benchmark', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByLabel('Benchmark seeds', { exact: true })).toHaveValue(
    'seed-one,seed-two',
  );
  await expect(page.getByLabel('Benchmark run limit', { exact: true })).toHaveValue('1');
  await expect(page.getByRole('button', { name: 'Run benchmark', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'Results', exact: true }).click();
  await page.getByRole('button', { name: 'Replay', exact: true }).first().click();
  await expect(page.locator('.status')).toHaveText('REPLAY');
  await page.getByRole('link', { name: 'Benchmark', exact: true }).click();
  await page.getByRole('button', { name: 'Watch current match', exact: true }).click();
  await expect(page).toHaveURL(/#arena$/);
  await expect(page.getByLabel('Replay position')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start match', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Mode', { exact: true })).toHaveValue('decision');
  await expect(page.getByRole('button', { name: 'Player 1', exact: true })).toContainText(
    'Bench Alpha',
  );
  await page.getByRole('link', { name: 'Benchmark', exact: true }).click();
  release();
  await expect(page.locator('.benchmark-status')).toHaveText('Completed');
  await expect(page.locator('.benchmark-count')).toContainText('4 / 4');
  await expect(page.getByRole('button', { name: 'Run benchmark', exact: true })).toBeEnabled();
  const state = await (await request.get('/api/state')).json();
  expect(state.benchmark.status).toBe('completed');
  expect(state.progress).toEqual({ total: 4, completed: 4, active: false });
  const rows = await (await request.get('/api/results')).json();
  const batch = rows.filter((s: any) => ['seed-one', 'seed-two'].includes(s.config.seed));
  expect(batch).toHaveLength(4);
  for (const row of batch) {
    expect(row.config.mode).toBe('decision');
    expect(row.config.maxSeconds).toBeNull();
    expect(row.config.maxTurns).toBe(1);
  }
  for (const seed of ['seed-one', 'seed-two']) {
    const pair = batch.filter((s: any) => s.config.seed === seed);
    expect(pair[0].config.players).toEqual([...pair[1].config.players].reverse());
  }
  expect(errors).toEqual([]);
});

test('validates setup, stops the current match and queue, and fits narrow screens', async ({
  page,
  request,
}) => {
  await page.goto('/#benchmark');
  await page.getByLabel('Benchmark seeds', { exact: true }).fill('');
  await expect(page.getByRole('button', { name: 'Run benchmark', exact: true })).toBeDisabled();
  await page.getByLabel('Benchmark seeds', { exact: true }).fill('cancel-one,cancel-two');
  await page.getByLabel('Benchmark run limit', { exact: true }).fill('30');
  hold = true;
  await page.getByRole('button', { name: 'Run benchmark', exact: true }).click();
  await expect(page.locator('.benchmark-status')).toHaveText('Running');
  await page.screenshot({ path: '.runtime/benchmark-light.png', fullPage: true });
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await page.screenshot({ path: '.runtime/benchmark-dark.png', fullPage: true });
  for (const width of [640, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  await page.getByRole('button', { name: '한국어', exact: true }).click();
  await expect(page.getByRole('heading', { name: '벤치마크', exact: true })).toBeVisible();
  await page.screenshot({ path: '.runtime/benchmark-mobile-ko.png', fullPage: true });
  await page.getByRole('button', { name: '벤치마크 중단', exact: true }).click();
  await expect(page.locator('.benchmark-status')).toHaveText('중단됨');
  const state = await (await request.get('/api/state')).json();
  expect(state.snapshot.reason).toBe('cancelled');
  expect(state.snapshot.config.mode).toBe('decision');
  expect(state.progress).toEqual({ total: 4, completed: 0, active: false });
  expect(state.benchmark.status).toBe('cancelled');
  await page.reload();
  await expect(page.locator('.benchmark-status')).toHaveText('Stopped');
  await expect(page.locator('.benchmark-count')).toContainText('0 / 4');
  expect(
    (await (await request.get('/api/results')).json()).filter(
      (s: any) => s.config.seed === 'cancel-two',
    ),
  ).toHaveLength(0);
});
