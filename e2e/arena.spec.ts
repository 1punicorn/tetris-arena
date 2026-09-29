import { test, expect } from '@playwright/test';
test('plays, exports and replays without another inference call', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start match' })).toBeEnabled();
  await expect(page.getByRole('img', { name: /Tetris board/ })).toHaveCount(2);
  await page.getByLabel('Mode', { exact: true }).selectOption('decision');
  await page.getByLabel('Run limit').fill('4');
  await page.getByRole('button', { name: 'Start match' }).click();
  await expect(page.locator('.status')).toHaveText('turn_limit');
  await expect(page.locator('.result').first()).toContainText('turn_limit');
  const state = await (await request.get('/api/state')).json();
  expect(state.snapshot.turn).toBe(4);
  expect(state.snapshot.stats[0].placements).toBe(4);
  await page.getByRole('button', { name: 'Replay', exact: true }).first().click();
  await expect(page.getByLabel('Replay position')).toBeVisible();
  await page.getByLabel('Replay position').fill('0');
  await expect(page.locator('.status')).toHaveText('REPLAY');
  expect((await (await request.get('/api/state')).json()).snapshot.stats).toEqual(
    state.snapshot.stats,
  );
  expect((await request.get('/api/results.csv')).headers()['content-type']).toContain('text/csv');
  expect(errors).toEqual([]);
});
test('keeps both boards visible and layout fixed with long latency values on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start match' })).toBeEnabled();
  await page.getByLabel('Player 2', { exact: true }).selectOption('none');
  await expect(page.getByRole('img', { name: /Tetris board/ })).toHaveCount(2);
  const before = await page.locator('.arena').boundingBox();
  await page
    .locator('.metrics b')
    .first()
    .evaluate((el) => {
      el.textContent = '123,456,789 ms';
    });
  const after = await page.locator('.arena').boundingBox();
  expect(after?.width).toBe(before?.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '한국어', exact: true }).click();
  await expect(page.getByRole('button', { name: '대전 시작' })).toBeVisible();
});
test('server play survives page navigation and can be stopped after reconnect', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start match' })).toBeEnabled();
  await page.getByLabel('Mode', { exact: true }).selectOption('realtime');
  await page.getByLabel('Run limit').fill('10');
  await page.getByRole('button', { name: 'Start match' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  const before = (await (await request.get('/api/state')).json()).snapshot.elapsedMs;
  await page.goto('about:blank');
  await expect
    .poll(async () => (await (await request.get('/api/state')).json()).snapshot.elapsedMs)
    .toBeGreaterThan(before + 500);
  await page.goto('/');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.status')).toHaveText('cancelled');
});

test('opens the arena when a user follows a link from another site', async ({ page, baseURL }) => {
  await page.route(`${baseURL}/`, (route) =>
    route.continue({
      headers: {
        ...route.request().headers(),
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    }),
  );
  await page.route('https://entry.example/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<a href="${baseURL}/">Open Tetris</a>`,
    }),
  );
  await page.goto('https://entry.example/');
  const response = page.waitForResponse(
    (r) => r.url() === `${baseURL}/` && r.request().isNavigationRequest(),
  );
  await page.getByRole('link', { name: 'Open Tetris' }).click();
  const navigation = await response;
  expect(navigation.status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Start match' })).toBeEnabled();
  await expect(page.getByRole('img', { name: /Tetris board/ })).toHaveCount(2);
});

test('a finished one-turn evaluation does not become the next visitor default', async ({
  page,
  request,
}) => {
  await request.post('/api/runs', { data: { mode: 'decision', maxTurns: 1, decisionStepMs: 0 } });
  await expect
    .poll(async () => (await (await request.get('/api/state')).json()).snapshot.status)
    .toBe('finished');
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start match' })).toBeEnabled();
  await expect(page.getByLabel('Mode', { exact: true })).toHaveValue('realtime');
  await expect(page.getByLabel('Run limit')).toHaveValue('');
  await expect(page.getByLabel('Run limit')).toHaveAttribute('placeholder', 'Unlimited');
  await page.getByRole('button', { name: 'Start match' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  const current = (await (await request.get('/api/state')).json()).snapshot;
  expect(current.config.maxSeconds).toBeNull();
  expect(current.config.maxTurns).toBeNull();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.status')).toHaveText('cancelled');
});
