import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('connects a provider once, enables searchable models and uses the shared key after reload', async ({
  page,
  request,
}) => {
  const observed: { model: string; authorization?: string }[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(
        JSON.stringify({
          data: [
            { id: 'fixture-alpha' },
            { id: 'fixture-beta' },
            ...Array.from({ length: 210 }, (_, i) => ({ id: `catalog-model-${i}` })),
          ],
        }),
      );
      return;
    }
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    observed.push({ model: body.model, authorization: req.headers.authorization });
    res.end(
      JSON.stringify({
        id: 'fixture',
        model: 'fixture-reported',
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
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const name = `Browser provider ${Date.now()}`;
  let providerId: string | undefined;
  try {
    await page.goto('/#settings');
    await page.getByLabel('Provider', { exact: true }).selectOption('openai-compatible');
    await page.getByLabel('Display name', { exact: true }).fill(name);
    await page.getByLabel('API base URL', { exact: true }).fill(url);
    await page.getByLabel('API key', { exact: true }).fill('browser-fixture-key');
    await page.getByRole('button', { name: 'Save & browse models', exact: true }).click();
    await expect(page.locator('.catalog-summary')).toContainText('212 models');
    const saved = (await (await request.get('/api/settings/providers')).json()).find(
      (p: { name: string }) => p.name === name,
    );
    providerId = saved.id;
    expect(saved.apiKey).toBeUndefined();
    expect(saved.hasApiKey).toBe(true);
    // Search covers the full catalog, including models beyond the first rendered page.
    await page.getByRole('searchbox', { name: 'Search provider models' }).fill('catalog-model-209');
    await expect(
      page.getByRole('checkbox', { name: 'catalog-model-209', exact: true }),
    ).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search provider models' }).fill('fixture');
    await page.getByRole('checkbox', { name: 'fixture-alpha', exact: true }).check();
    await page.getByRole('checkbox', { name: 'fixture-beta', exact: true }).check();
    await page.getByRole('button', { name: 'Apply models', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Models applied');
    await page.reload();
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('button', { name: 'Connection', exact: true }).click();
    await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('API key', { exact: true })).toHaveAttribute(
      'placeholder',
      /Saved/,
    );
    await page.getByRole('button', { name: 'Save provider', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Models', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('searchbox', { name: 'Search provider models' }).fill('fixture');
    await page.getByRole('checkbox', { name: 'fixture-beta', exact: true }).uncheck();
    await page.getByRole('button', { name: 'Apply models', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Models applied');
    await page.getByRole('button', { name: 'Options for fixture-alpha', exact: true }).click();
    await page.getByRole('button', { name: 'Test saved model', exact: true }).click();
    await expect(page.locator('.model-options [role="status"]')).toContainText('Test passed');
    expect(observed[0]).toEqual({
      model: 'fixture-alpha',
      authorization: 'Bearer browser-fixture-key',
    });
    // Manual registration works alongside discovery, with one shared provider credential.
    await page.getByLabel('Add a model ID manually', { exact: true }).fill('manual-model');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Apply models', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Models applied');
    await page.getByRole('link', { name: 'Arena', exact: true }).click();
    await page.getByRole('button', { name: 'Player 1', exact: true }).click();
    const search = page.getByRole('combobox', { name: 'Search models', exact: true });
    await search.fill('fixture-beta');
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0);
    await search.fill('manual-model');
    await search.press('Enter');
    await expect(page.getByRole('button', { name: 'Player 1', exact: true })).toContainText(
      'manual-model',
    );
    await page.getByRole('button', { name: 'Player 2', exact: true }).click();
    await search.fill('Spectator');
    await search.press('Enter');
    await page.getByLabel('Mode', { exact: true }).selectOption('decision');
    await page.getByLabel('Run limit').fill('1');
    await page.getByRole('button', { name: 'Start match' }).click();
    await expect(page.locator('.status')).toHaveText('turn_limit');
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual({
      model: 'manual-model',
      authorization: 'Bearer browser-fixture-key',
    });
    await page.getByRole('button', { name: 'Benchmark models', exact: true }).click();
    await search.fill('fixture-alpha');
    const option = page.getByRole('listbox').getByRole('option');
    const wasSelected = await option.getAttribute('aria-selected');
    await search.press('Enter');
    await expect(option).toHaveAttribute(
      'aria-selected',
      wasSelected === 'true' ? 'false' : 'true',
    );
    await search.press('Escape');
    await expect(page.getByRole('button', { name: 'Benchmark models', exact: true })).toBeFocused();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('searchbox', { name: 'Search provider models' }).fill('fixture');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: '.runtime/provider-catalog-light.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await page.screenshot({
      path: '.runtime/provider-catalog-dark.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Switch to light mode' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.screenshot({
      path: '.runtime/provider-catalog-mobile.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Connection', exact: true }).click();
    await page.getByRole('button', { name: 'Delete provider', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Provider deleted');
    expect(
      (await (await request.get('/api/connections')).json()).some(
        (p: { providerId?: string }) => p.providerId === providerId,
      ),
    ).toBe(false);
  } finally {
    if (providerId) await request.delete(`/api/settings/providers/${providerId}`).catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('prefills known endpoints and keeps the settings form usable on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#settings');
  await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue(
    'https://api.openai.com/v1',
  );
  await page.getByLabel('Provider', { exact: true }).selectOption('anthropic');
  await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue(
    'https://api.anthropic.com/v1',
  );
  await page.getByLabel('Provider', { exact: true }).selectOption('google');
  await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue(
    'https://generativelanguage.googleapis.com/v1beta',
  );
  await page.getByLabel('Provider', { exact: true }).selectOption('ollama');
  await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue(
    'http://localhost:11434/v1',
  );
  await page.getByRole('button', { name: '한국어', exact: true }).click();
  await expect(page.getByLabel('표시 이름', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: '.runtime/settings-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('searches and navigates a large model dropdown on mobile without moving the page', async ({
  page,
}) => {
  const models = Array.from({ length: 205 }, (_, i) => ({
    id: `large-${i}`,
    name: `Model ${String(i).padStart(3, '0')}`,
    model: `model-${i}`,
    provider: 'openai-compatible',
    providerName: 'Search fixture',
    reasoning: 'provider-default',
    available: true,
  }));
  await page.route('**/api/connections', (route) => route.fulfill({ json: models }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('Mode', { exact: true }).selectOption('decision');
  const trigger = page.getByRole('button', { name: 'Player 1', exact: true });
  await trigger.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => scrollY);
  await trigger.click();
  const search = page.getByRole('combobox', { name: 'Search models', exact: true });
  await expect(search).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(before);
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(100);
  await search.press('ArrowUp'); // Wrap to the final model beyond the initially rendered 100.
  await expect(page.getByRole('option', { name: /Model 204/ })).toBeInViewport();
  await search.press('Enter');
  await expect(trigger).toContainText('Model 204');
  await trigger.click();
  await search.fill('model-203');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1);
  await search.press('Escape');
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: 'Benchmark models', exact: true }).click();
  await search.fill('Search fixture');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(100);
  await search.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
