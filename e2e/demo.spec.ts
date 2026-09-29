import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SettingsStore } from '../src/server/settings-store.js';

// The provider is entirely local; these tests never use real model credentials.
test('shows the original UI read-only, shares matches and preserves dated replays', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const dir = await mkdtemp(resolve('.runtime/e2e-demo-'));
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = createServer(async (req, res) => {
    calls++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    await gate;
    const body = JSON.parse(raw);
    const message = body.messages.find((m: { role: string }) => m.role === 'user');
    const { options } = JSON.parse(
      typeof message.content === 'string' ? message.content : message.content[0].text,
    );
    // Deliberately stack high to finish a real match quickly and deterministically.
    const height = (text: string) => Number(text.match(/ height=(\d+)/)?.[1] ?? 0);
    const choice = Object.entries(options as Record<string, string>).sort(
      (a, b) => height(b[1]) - height(a[1]),
    )[0][0];
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'demo-fixture',
        model: body.model,
        created: 1,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify({ choice }) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
      }),
    );
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const store = new SettingsStore(`${dir}/settings.sqlite`);
  const provider = store.saveProvider({
    name: 'Demo fixture',
    apiKey: 'private-e2e-demo-key',
    kind: 'openai-compatible',
    baseURL: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`,
  });
  const first = store.saveModel(provider.id, { name: 'Demo Jev', model: 'fixture/jev' });
  const second = store.saveModel(provider.id, { name: 'Demo DeepSeek', model: 'fixture/deepseek' });
  store.saveModel(provider.id, { name: 'Hidden model', model: 'fixture/hidden' });
  store.close();
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const entry =
    process.env.E2E_SERVER_COMMAND?.match(/^node (.+)$/)?.[1] ?? 'dist/server/server/main.js';
  const start = () =>
    spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        PUBLIC_ORIGIN: '',
        PUBLIC_ACCESS: '',
        PUBLIC_USERNAME: '',
        PUBLIC_PASSWORD: '',
        TRUSTED_PROXY_IP: '',
        SETTINGS_DB: `${dir}/settings.sqlite`,
        RESULTS_DIR: `${dir}/results`,
        CONNECTIONS_FILE: '.runtime/no-connections.json',
        DEMO_MODELS: `${first.id},${second.model}`,
      },
      stdio: 'ignore',
    });
  let server = start();
  const stop = async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const ended = once(server, 'exit');
    server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 3000);
    await ended;
    clearTimeout(force);
  };
  const origin = `http://127.0.0.1:${port}`;
  const ready = () =>
    expect
      .poll(async () => {
        try {
          return (await fetch(`${origin}/api/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
  const context = await browser.newContext();
  const visitor = await context.newPage();
  const errors: string[] = [];
  for (const p of [page, visitor]) p.on('pageerror', (error) => errors.push(error.message));
  try {
    await ready();
    await page.goto(`${origin}/#settings`);
    await expect(page).toHaveURL(/#settings$/);
    await expect(page.locator('.main-nav a')).toHaveText([
      'Arena',
      'Benchmark',
      'Results',
      'Replay',
      'Settings',
    ]);
    await expect(page.getByRole('note')).toContainText('read-only');
    await expect(page.getByRole('button', { name: 'Add provider', exact: false })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^Options for / })).toHaveCount(2);
    await expect(page.getByRole('checkbox', { name: 'Demo Jev', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
    await page.getByRole('searchbox', { name: 'Search provider models' }).fill('jev');
    await expect(page.locator('.catalog-row')).toHaveCount(1);
    await page.getByRole('button', { name: /^Options for / }).click();
    await expect(
      page.locator('.model-options').getByRole('button', { name: 'Save options', exact: true }),
    ).toBeDisabled();
    await expect(
      page.locator('.model-options').getByRole('button', { name: 'Test saved model', exact: true }),
    ).toBeDisabled();
    await expect(
      page.locator('.model-options').getByLabel('Temperature', { exact: true }),
    ).toBeDisabled();
    await page
      .locator('.model-options')
      .getByRole('button', { name: 'Preview request', exact: true })
      .click();
    await expect(page.getByLabel('Request JSON')).toContainText('fixture/jev');
    await page.getByRole('button', { name: 'Connection', exact: true }).click();
    await expect(page.getByLabel('API key', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('API base URL', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save provider', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Delete provider', exact: true })).toBeDisabled();
    await page.getByRole('tab', { name: 'Prompts & requests', exact: true }).click();
    await expect(page.getByLabel('Common instructions', { exact: true })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Save prompts & requests', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('tabpanel')
      .getByRole('button', { name: 'Preview request', exact: true })
      .click();
    await expect(page.getByRole('tabpanel').getByLabel('Request JSON')).toContainText(
      'fixture/jev',
    );
    await page.getByRole('tab', { name: 'LLM', exact: true }).click();
    await expect(
      page.getByRole('tabpanel').getByLabel('Temperature', { exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('tabpanel').getByRole('button', { name: 'Model to configure', exact: true }),
    ).toBeEnabled();
    await page
      .getByRole('tabpanel')
      .getByRole('button', { name: 'Model to configure', exact: true })
      .click();
    await page.getByRole('option', { name: /Demo DeepSeek/ }).click();
    await expect(
      page
        .getByRole('region', { name: 'Demo DeepSeek', exact: true })
        .getByRole('button', { name: 'Save options', exact: true }),
    ).toBeDisabled();
    expect(calls).toBe(0);
    expect(await page.content()).not.toContain('private-e2e-demo-key');
    await page.getByRole('link', { name: 'Benchmark', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Benchmark models', exact: true }),
    ).toBeDisabled();
    await expect(page.getByLabel('Benchmark seeds', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Run benchmark', exact: true })).toBeDisabled();
    await page.getByRole('link', { name: 'Replay', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Browse results', exact: false })).toBeVisible();
    await page.getByRole('link', { name: 'Arena', exact: true }).click();
    for (const name of ['Pause', 'Stop', 'Player 1', 'Player 2'])
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    for (const label of ['Mode', 'Seed', 'Run limit'])
      await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
    await visitor.goto(origin);
    await expect(visitor.getByRole('button', { name: 'Start match', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Start match', exact: true }).click();
    await expect(visitor.getByRole('button', { name: 'Start match', exact: true })).toBeDisabled();
    const initial = await (await page.request.get(`${origin}/api/state`)).json();
    expect(initial.snapshot.config).toMatchObject({
      mode: 'realtime',
      players: [first.id, second.id],
      maxSeconds: null,
    });
    await expect(page.locator('.match-strip')).toHaveAttribute('data-run-id', initial.snapshot.id);
    await expect(visitor.locator('.match-strip')).toHaveAttribute(
      'data-run-id',
      initial.snapshot.id,
    );
    await visitor.reload();
    await expect(visitor.locator('.match-strip')).toHaveAttribute(
      'data-run-id',
      initial.snapshot.id,
    );
    expect((await visitor.request.post(`${origin}/api/runs`, { data: {} })).status()).toBe(409);
    for (const path of ['pause', 'cancel', 'bench', 'action'])
      expect((await visitor.request.post(`${origin}/api/${path}`, { data: {} })).status()).toBe(
        403,
      );
    release();
    await expect(page.getByRole('button', { name: 'Start match', exact: true })).toBeEnabled({
      timeout: 80000,
    });
    const completed = await (await page.request.get(`${origin}/api/state`)).json();
    expect(completed.snapshot.reason).toBe('top_out');
    expect(completed.canStart).toBe(true);
    const finalCalls = calls;
    expect(finalCalls).toBeGreaterThan(0);
    await page.getByRole('link', { name: 'Results', exact: true }).click();
    const record = (await (await page.request.get(`${origin}/api/results`)).json())[0];
    await expect(page.locator('.result time').first()).toHaveAttribute(
      'datetime',
      record.createdAt,
    );
    await expect(page.locator('.result time').first()).not.toHaveText('');
    await page.locator(`.result a[href="#replay/${initial.snapshot.id}"]`).click();
    await expect(page.getByLabel('Replay position')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start match', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Play replay', exact: true }).click();
    await expect
      .poll(async () => Number(await page.getByLabel('Replay position').inputValue()))
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Pause replay', exact: true }).click();
    await page.getByRole('link', { name: 'Choose another match', exact: false }).click();
    await expect(page.locator('.result .replay-link')).toBeVisible();
    expect(calls).toBe(finalCalls);
    await stop();
    server = start();
    await ready();
    await page.goto(`${origin}/#replay/${initial.snapshot.id}`);
    await expect(page.getByLabel('Replay position')).toBeVisible();
    expect(calls).toBe(finalCalls);
    const history = Array.from({ length: 33 }, (_, i) => ({
      ...completed.snapshot,
      id: `fixture-${i}`,
      createdAt: new Date(Date.UTC(2026, 8, 29, 12, 0, 33 - i)).toISOString(),
    }));
    await page.route('**/api/results?*', async (route) => {
      const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
      await route.fulfill({ json: history.slice(offset, offset + 30) });
    });
    await page.getByRole('link', { name: 'Results', exact: true }).click();
    await expect(page.locator('.result')).toHaveCount(30);
    await page.getByRole('button', { name: 'Load older matches', exact: true }).click();
    await expect(page.locator('.result')).toHaveCount(33);
    await expect(page.getByRole('button', { name: 'Load older matches', exact: true })).toHaveCount(
      0,
    );
    await page.unroute('**/api/results?*');
    await page.getByRole('link', { name: 'Arena', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start match', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '한국어', exact: true }).click();
    await expect(
      page.getByText('모든 방문자가 같은 실시간 경기를 관전합니다.', { exact: false }),
    ).toBeVisible();
    for (const width of [640, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      const boards = await page.getByRole('img', { name: /Tetris board/ }).all();
      const firstBoard = (await boards[0].boundingBox())!;
      const secondBoard = (await boards[1].boundingBox())!;
      expect(Math.abs(firstBoard.y - secondBoard.y)).toBeLessThan(1);
    }
    await page.screenshot({ path: '.runtime/readonly-demo-mobile.png', fullPage: true });
    await page.getByRole('button', { name: '다크 모드로 전환', exact: true }).click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.goto(`${origin}/#benchmark`);
    await expect(page).toHaveURL(/#benchmark$/);
    expect((await page.request.get(`${origin}/api/settings/experiment`)).status()).toBe(200);
    expect(
      (await page.request.post(`${origin}/api/runs`, { data: { mode: 'decision' } })).status(),
    ).toBe(400);
    expect(errors).toEqual([]);
  } finally {
    release();
    await context.close();
    await stop();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
