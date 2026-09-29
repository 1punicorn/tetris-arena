import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SettingsStore } from '../src/server/settings-store.js';

test('loads an environment-configured demo with fixed models and read-only settings', async ({
  page,
}) => {
  const dir = await mkdtemp(resolve('.runtime/e2e-demo-'));
  const store = new SettingsStore(`${dir}/settings.sqlite`);
  const provider = store.saveProvider({
    name: 'Demo fixture',
    kind: 'openrouter',
    apiKey: 'demo-fixture-key',
  });
  const decision = store.saveModel(provider.id, {
    name: 'Demo Jev',
    model: 'fixture/jev',
    api: 'decisions',
  });
  const llm = store.saveModel(provider.id, { name: 'Demo DeepSeek', model: 'fixture/deepseek' });
  store.saveModel(provider.id, { name: 'Hidden model', model: 'fixture/hidden' });
  store.close();
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  const entry =
    process.env.E2E_SERVER_COMMAND?.match(/^node (.+)$/)?.[1] ?? 'dist/server/server/main.js';
  const server = spawn(process.execPath, [entry], {
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
      DEMO_MODELS: `${decision.id},${llm.model}`,
    },
    stdio: 'ignore',
  });
  const origin = `http://127.0.0.1:${port}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${origin}/api/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    await page.goto(origin);
    await expect(page.getByRole('button', { name: 'Start match', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Player 1', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Player 1', exact: true })).toContainText(
      'Demo Jev',
    );
    await expect(page.getByRole('button', { name: 'Player 2', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Player 2', exact: true })).toContainText(
      'Demo DeepSeek',
    );
    await expect(page.locator('.model-select-hint')).toHaveText([
      'Models cannot be changed in demo mode.',
      'Models cannot be changed in demo mode.',
    ]);
    const connections = await (await page.request.get(`${origin}/api/connections`)).json();
    expect(connections.map((model: any) => model.id)).toEqual([decision.id, llm.id]);
    await page.getByRole('link', { name: 'Benchmark', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Benchmark models', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('list', { name: 'Selected benchmark models' }).locator('li'),
    ).toHaveCount(2);
    await expect(page.locator('.benchmark-remove')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Run benchmark', exact: true })).toBeEnabled();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.locator('.demo-settings-notice')).toContainText('All settings are read-only');
    await expect(page.getByRole('button', { name: 'Add provider', exact: true })).toHaveCount(0);
    await expect(page.locator('.demo-models')).toContainText('Demo DeepSeek');
    await page.getByRole('tab', { name: 'Prompts & requests', exact: true }).click();
    const prompts = page.getByRole('tabpanel');
    await expect(prompts.getByLabel('Common instructions', { exact: true })).toBeDisabled();
    await expect(
      prompts.getByRole('button', { name: 'Save prompts & requests', exact: true }),
    ).toBeDisabled();
    await prompts.getByRole('button', { name: 'Preview request', exact: true }).click();
    await expect(prompts.getByLabel('Request JSON')).toContainText('"model": "fixture/jev"');
    await page.getByRole('tab', { name: 'LLM', exact: true }).click();
    const llmPanel = page.getByRole('tabpanel');
    await expect(llmPanel.getByLabel('Temperature', { exact: true })).toBeDisabled();
    await expect(
      llmPanel.getByRole('button', { name: 'Save options', exact: true }),
    ).toBeDisabled();
    await expect(
      llmPanel.getByRole('button', { name: 'Test saved model', exact: true }),
    ).toBeDisabled();
    await llmPanel.getByRole('button', { name: 'Preview request', exact: true }).click();
    await expect(llmPanel.getByLabel('Request JSON')).toContainText('"model": "fixture/deepseek"');
    await page.getByRole('button', { name: '한국어', exact: true }).click();
    await page.getByRole('link', { name: '대전', exact: true }).click();
    await expect(page.locator('.model-select-hint').first()).toHaveText(
      '데모 모드에서는 모델을 변경할 수 없습니다.',
    );
    for (const width of [640, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
    await page.screenshot({ path: '.runtime/demo-mobile.png', fullPage: true });
    await page.getByRole('button', { name: '다크 모드로 전환', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Player 1', exact: true })).toBeDisabled();
    expect(
      (await page.request.put(`${origin}/api/settings/experiment`, { data: {} })).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post(`${origin}/api/runs`, { data: { players: [decision.id, 'human'] } })
      ).status(),
    ).toBe(403);
    expect(errors).toEqual([]);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const ended = once(server, 'exit');
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 3000);
      await ended;
      clearTimeout(force);
    }
    await rm(dir, { recursive: true, force: true });
  }
});
