import { test, expect } from '@playwright/test';

test('shows one selected model, preserves drafts and restores documented defaults without saving', async ({
  page,
  request,
}) => {
  const provider = await (
    await request.post('/api/settings/providers', {
      data: { name: 'Protocol fixture', kind: 'openrouter', apiKey: 'protocol-fixture-key' },
    })
  ).json();
  await (
    await request.put(`/api/settings/providers/${provider.id}/models`, {
      data: {
        models: [
          { name: 'Decision Alpha', model: 'fixture/decision-alpha', api: 'decisions' },
          { name: 'Decision Beta', model: 'fixture/decision-beta', api: 'decisions' },
          { name: 'LLM Alpha', model: 'fixture/llm-alpha', api: 'default' },
        ],
      },
    })
  ).json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('/#settings');
    await page.getByRole('tab', { name: 'Decisions', exact: true }).click();
    const decisions = page.getByRole('tabpanel', { name: 'Decisions', exact: true });
    const first = decisions.getByRole('region', { name: 'Decision Alpha', exact: true });
    const selectModel = async (name: string) => {
      await page.getByRole('button', { name: 'Model to configure', exact: true }).click();
      await page.getByRole('combobox', { name: 'Search models', exact: true }).fill(name);
      await page.getByRole('option', { name: new RegExp(name) }).click();
    };
    await expect(first.getByLabel('Additional model instructions')).toBeVisible();
    await expect(decisions.getByRole('region')).toHaveCount(1);
    await expect(
      decisions.getByRole('region', { name: 'Decision Beta', exact: true }),
    ).toBeHidden();
    await expect(decisions.getByLabel('Temperature', { exact: true })).toHaveCount(0);
    await expect(
      decisions.getByRole('combobox', { name: 'Output format', exact: true }),
    ).toHaveCount(0);
    await expect(first).toContainText('Protocol fixture · fixture/decision-alpha');
    await first
      .getByLabel('Additional model instructions')
      .fill('Decision draft: prepare Tetrises.');
    await selectModel('Decision Beta');
    await expect(first).toBeHidden();
    await expect(decisions.getByRole('region')).toHaveCount(1);
    const second = decisions.getByRole('region', { name: 'Decision Beta', exact: true });
    await second.getByLabel('Additional model instructions').fill('Beta draft, not saved.');
    await selectModel('Decision Alpha');
    await expect(first.getByLabel('Additional model instructions')).toHaveValue(
      'Decision draft: prepare Tetrises.',
    );
    await page.getByRole('tab', { name: 'Decisions', exact: true }).press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'LLM', exact: true })).toBeFocused();
    const llm = page.getByRole('tabpanel', { name: 'LLM', exact: true });
    const llmModel = llm.getByRole('region', { name: 'LLM Alpha', exact: true });
    await expect(llmModel.getByLabel('Max output tokens', { exact: true })).toHaveValue('1024');
    await expect(llmModel.getByLabel('Temperature', { exact: true })).toHaveValue('');
    await expect(llmModel.getByRole('combobox', { name: 'Reasoning', exact: true })).toHaveValue(
      'provider-default',
    );
    await expect(
      llmModel.getByRole('combobox', { name: 'Output format', exact: true }),
    ).toHaveValue('schema');
    await expect(llmModel.locator('.model-defaults')).toContainText('1,024 output tokens');
    await llmModel.getByLabel('Temperature', { exact: true }).fill('0.35');
    await llmModel.getByLabel('Max output tokens', { exact: true }).fill('321');
    await llmModel
      .getByRole('combobox', { name: 'Output format', exact: true })
      .selectOption('json-text');
    await page.getByRole('tab', { name: 'Prompts & requests', exact: true }).click();
    await page.getByRole('tab', { name: 'Decisions', exact: true }).click();
    await expect(
      decisions.getByRole('button', { name: 'Model to configure', exact: true }),
    ).toContainText('Decision Alpha');
    await expect(first.getByLabel('Additional model instructions')).toHaveValue(
      'Decision draft: prepare Tetrises.',
    );
    await first.getByRole('button', { name: 'Preview request', exact: true }).click();
    await expect(first.getByLabel('Request JSON')).toContainText(
      'Decision draft: prepare Tetrises.',
    );
    await expect(first.getByLabel('Request JSON')).toContainText('"questions"');
    await expect(first.getByLabel('Request JSON')).not.toContainText('"temperature"');
    await first.getByRole('button', { name: 'Save options', exact: true }).click();
    await expect(first.getByRole('status')).toHaveText('Options saved.');
    await selectModel('Decision Beta');
    await expect(second.getByLabel('Additional model instructions')).toHaveValue(
      'Beta draft, not saved.',
    );
    await selectModel('Decision Alpha');
    const afterDecisionSave = await (
      await request.get(`/api/settings/providers/${provider.id}/models`)
    ).json();
    expect(
      afterDecisionSave.find((m: any) => m.model === 'fixture/decision-alpha')
        .additionalInstructions,
    ).toContain('Decision draft');
    expect(
      afterDecisionSave.find((m: any) => m.model === 'fixture/decision-beta')
        .additionalInstructions,
    ).toBe('');
    expect(
      afterDecisionSave.find((m: any) => m.model === 'fixture/llm-alpha').generation.temperature,
    ).toBeUndefined();
    await page.getByRole('tab', { name: 'LLM', exact: true }).click();
    await expect(llmModel.getByLabel('Temperature', { exact: true })).toHaveValue('0.35');
    await llmModel.getByRole('button', { name: 'Preview request', exact: true }).click();
    await expect(llmModel.getByLabel('Request JSON')).toContainText('"max_tokens": 321');
    await expect(llmModel.getByLabel('Request JSON')).toContainText('"temperature": 0.35');
    await expect(llmModel.getByLabel('Request JSON')).toContainText('"messages"');
    await expect(llmModel.getByLabel('Request JSON')).not.toContainText('protocol-fixture-key');
    await llmModel.getByRole('button', { name: 'Save options', exact: true }).click();
    await expect(llmModel.getByRole('status')).toHaveText('Options saved.');
    await llmModel.getByRole('button', { name: 'Reset model options', exact: true }).click();
    await expect(llmModel.getByRole('status')).toContainText('Save to apply');
    await expect(llmModel.getByLabel('Max output tokens', { exact: true })).toHaveValue('1024');
    await expect(llmModel.getByLabel('Temperature', { exact: true })).toHaveValue('');
    await expect(
      llmModel.getByRole('combobox', { name: 'Output format', exact: true }),
    ).toHaveValue('schema');
    await llmModel.getByRole('button', { name: 'Preview request', exact: true }).click();
    await expect(llmModel.getByLabel('Request JSON')).toContainText('"max_tokens": 1024');
    await expect(llmModel.getByLabel('Request JSON')).not.toContainText('"temperature"');
    await llmModel.getByLabel('Max output tokens', { exact: true }).fill('');
    await llmModel.getByRole('button', { name: 'Preview request', exact: true }).click();
    await expect(llmModel.getByLabel('Request JSON')).toContainText('"messages"');
    await expect(llmModel.getByLabel('Request JSON')).not.toContainText('"max_tokens"');
    await page.reload();
    await page.getByRole('tab', { name: 'LLM', exact: true }).click();
    await expect(llmModel.getByLabel('Temperature', { exact: true })).toHaveValue('0.35');
    await expect(
      llmModel.getByRole('combobox', { name: 'Output format', exact: true }),
    ).toHaveValue('json-text');
    await page.screenshot({ path: '.runtime/protocol-settings-light.png', fullPage: true });
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await page.setViewportSize({ width: 320, height: 844 });
    await page.getByRole('button', { name: '한국어', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
    await page.screenshot({ path: '.runtime/protocol-settings-mobile.png', fullPage: true });
    await page.getByRole('tab', { name: 'Decisions', exact: true }).click();
    await expect(first.getByLabel('모델별 추가 지침')).toHaveValue(
      'Decision draft: prepare Tetrises.',
    );
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/settings/providers/${provider.id}`).catch(() => {});
  }
});
