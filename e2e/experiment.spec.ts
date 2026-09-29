import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('edits shared and per-model strategies, previews without inference and records the applied experiment', async ({
  page,
  request,
}) => {
  const panel = page.getByRole('tabpanel');
  const original = await (await request.get('/api/settings/experiment')).json();
  const observed: any[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'strategy-fixture' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    observed.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'fixture',
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
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const provider = await (
    await request.post('/api/settings/providers', {
      data: {
        name: 'Strategy fixture',
        kind: 'openai-compatible',
        baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        apiKey: 'fixture-private-key',
      },
    })
  ).json();
  const model = await (
    await request.post(`/api/settings/providers/${provider.id}/models`, {
      data: { name: 'Strategy model', model: 'strategy-fixture' },
    })
  ).json();
  try {
    await page.goto('/#settings');
    await page.getByRole('tab', { name: 'Prompts & requests', exact: true }).click();
    await page.getByRole('button', { name: 'Triple / Tetris attack preset', exact: true }).click();
    await expect(panel.getByLabel('Common instructions', { exact: true })).toHaveValue(
      /triples and Tetrises/,
    );
    await expect(panel.getByLabel('Strategy priorities — one per line')).not.toHaveValue(
      /Take safe available clears, including singles/,
    );
    await panel
      .getByLabel('Common instructions', { exact: true })
      .fill('Browser experiment: prepare a triple or Tetris.');
    await panel.getByLabel('Request timeout (ms)').fill('15000');
    await panel.getByLabel('Attempts per decision').fill('2');
    await page.getByRole('button', { name: 'Preview request', exact: true }).click();
    await expect(panel.getByLabel('Request JSON')).toContainText('Browser experiment');
    expect(observed).toHaveLength(0);
    await page.getByRole('button', { name: 'Save prompts & requests', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved for the next match');
    await page.reload();
    await page.getByRole('tab', { name: 'Prompts & requests', exact: true }).click();
    await expect(panel.getByLabel('Common instructions', { exact: true })).toHaveValue(
      'Browser experiment: prepare a triple or Tetris.',
    );
    // Restoring is a draft action until saved; previews follow the editor.
    await page.getByRole('button', { name: 'Reset prompts', exact: true }).click();
    await expect(panel.getByLabel('Common instructions', { exact: true })).toHaveValue(
      /Prefer safe line clears now/,
    );
    expect(
      (await (await request.get('/api/settings/experiment')).json()).prompts.instruction,
    ).toContain('Browser experiment');
    await page.getByRole('tab', { name: 'Providers & models', exact: true }).click();
    await page.getByRole('button', { name: /Strategy fixture/ }).click();
    await page.getByRole('button', { name: 'Options for Strategy model', exact: true }).click();
    await panel.getByLabel('Additional model instructions').fill('Use hold to complete triples.');
    await panel.getByLabel('Max output tokens', { exact: true }).fill('333');
    await panel.getByLabel('Temperature', { exact: true }).fill('0.25');
    await panel.getByLabel('Extra request body (JSON)', { exact: true }).fill('{"min_p": 0.05}');
    await page.getByRole('button', { name: 'Preview request', exact: true }).click();
    await expect(panel.getByLabel('Request JSON')).toContainText('Use hold to complete triples.');
    await expect(panel.getByLabel('Request JSON')).toContainText('Browser experiment');
    await expect(panel.getByLabel('Request JSON')).toContainText('"max_tokens": 333');
    await expect(panel.getByLabel('Request JSON')).not.toContainText('fixture-private-key');
    expect(observed).toHaveLength(0);
    await page.getByRole('button', { name: 'Save options', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/settings/providers/${provider.id}/models`)).json())[0]
            .generation.maxOutputTokens,
      )
      .toBe(333);
    await page.getByRole('button', { name: 'Options for Strategy model', exact: true }).click();
    // The actual model test uses saved shared and per-model settings.
    await page.getByRole('button', { name: 'Test saved model', exact: true }).click();
    await expect(page.locator('.model-options [role="status"]')).toContainText('Test passed');
    expect(observed).toHaveLength(1);
    expect(observed[0].messages[0].content).toContain(
      'Browser experiment: prepare a triple or Tetris.\n\nUse hold to complete triples.',
    );
    expect(observed[0]).toMatchObject({ max_tokens: 333, temperature: 0.25, min_p: 0.05 });
    const run = await (
      await request.post('/api/runs', {
        data: { mode: 'decision', players: [model.id, 'none'], maxTurns: 1, decisionStepMs: 0 },
      })
    ).json();
    await expect
      .poll(async () => (await (await request.get('/api/state')).json()).snapshot.status)
      .toBe('finished');
    const metadata = await (await request.get(`/api/results/${run.id}/metadata.json`)).json();
    expect(metadata.experiment.prompts.instruction).toContain('Browser experiment');
    expect(metadata.experiment.timeoutMs).toBe(15000);
    expect(metadata.connections[0].additionalInstructions).toBe('Use hold to complete triples.');
    await page.getByRole('tab', { name: 'Prompts & requests', exact: true }).click();
    await page.screenshot({ path: '.runtime/experiment-light.png', fullPage: true });
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await page.screenshot({ path: '.runtime/experiment-dark.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.screenshot({ path: '.runtime/experiment-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 320, height: 750 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  } finally {
    await request.post('/api/cancel', { data: {} });
    await request.put('/api/settings/experiment', { data: original });
    await request.delete(`/api/settings/providers/${provider.id}`);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
