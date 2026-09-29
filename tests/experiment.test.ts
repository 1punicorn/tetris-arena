import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ExperimentSchema, ATTACK_PROMPTS, DEFAULT_PROMPTS } from '../src/core/experiment.js';
import { makeProblem } from '../src/core/observation.js';
import { startGame } from '../src/core/engine.js';
import { random } from '../src/core/random.js';
import { buildCandidates } from '../src/core/ai-candidates.js';
import { createAgent, previewRequest, OUTPUT_INSTRUCTION } from '../src/providers/agents.js';
import { ProfileSchema } from '../src/providers/config.js';
import { SettingsStore } from '../src/server/settings-store.js';
import { Manager } from '../src/server/manager.js';
import { Artifacts } from '../src/server/artifacts.js';
import { createApp } from '../src/server/app.js';

const game = startGame(random('experiment'));
const candidates = buildCandidates(game);
const problem = makeProblem(game, game, candidates, 'experiment', 'decision', ATTACK_PROMPTS);
const profile = (extra = {}) =>
  ProfileSchema.parse({
    id: 'test',
    name: 'Test',
    provider: 'openai-compatible',
    baseURL: 'http://127.0.0.1:9/v1',
    model: 'fixture',
    apiKey: 'hidden-provider-key',
    reasoning: 'provider-default',
    ...extra,
  });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('previews cloud credential-chain configurations without contacting authentication services', async () => {
  vi.stubEnv('GOOGLE_VERTEX_API_KEY', '');
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', '');
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
  const vertex = await previewRequest(
    profile({
      provider: 'vertex',
      apiKey: undefined,
      baseURL: undefined,
      project: 'fixture-project',
      location: 'us-central1',
      model: 'gemini-2.5-flash',
    }),
    problem,
  );
  expect(vertex.endpoint).toContain('/projects/fixture-project/locations/us-central1/');
  const bedrock = await previewRequest(
    profile({
      provider: 'bedrock',
      apiKey: undefined,
      baseURL: undefined,
      region: 'us-east-1',
      model: 'amazon.nova-pro-v1:0',
    }),
    problem,
  );
  expect(bedrock.endpoint).toContain('bedrock-runtime.us-east-1.amazonaws.com');
  expect(external).not.toHaveBeenCalled();
});

it('replaces every editable prompt section while retaining the exact legal candidates and mode context', () => {
  const prompts = {
    ...DEFAULT_PROMPTS,
    instruction: '',
    strategy: ['Prefer triples'],
    duelGoal: 'Win now',
    soloGoal: 'Solo experiment',
    realtimeRules: 'Custom realtime',
    decisionRules: 'Custom decision',
    realtimeAttack: 'Attack immediately',
    decisionAttack: 'Attack together',
    legend: 'Custom legend',
  };
  const custom = makeProblem(game, game, candidates, 'experiment', 'decision', prompts);
  expect(custom.instruction).toBe('');
  expect(custom.state).toMatchObject({
    goal: 'Win now',
    strategy: ['Prefer triples'],
    rules: 'Custom decision',
    attack_rules: 'Attack together',
    legend: 'Custom legend',
  });
  expect(custom.options).toEqual(problem.options);
  expect(custom.candidates).toEqual(problem.candidates);
  expect(JSON.stringify(custom)).not.toContain('Clear lines: compare now.clear first');
  expect(makeProblem(game, game, [], 'x', 'realtime', prompts).state).toMatchObject({
    rules: 'Custom realtime',
    attack_rules: 'Attack immediately',
  });
  const solo = makeProblem(game, undefined, [], 'x', 'decision', prompts);
  expect(solo.state.goal).toBe('Solo experiment');
  expect(solo.state).not.toHaveProperty('opponent');
  expect(solo.state).not.toHaveProperty('attack_rules');
});

it.each(['openai-compatible', 'openrouter-decisions'])(
  'previews the same %s body used for inference without making external requests',
  async (provider) => {
    const external = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected network'));
    const p = profile({
      provider,
      baseURL:
        provider === 'openrouter-decisions'
          ? 'https://openrouter.ai/api/v1'
          : 'http://127.0.0.1:9/v1',
      additionalInstructions: 'Prefer a triple over an unnecessary single.',
      generation: { maxOutputTokens: 321, temperature: 0.2, topP: 0.8, seed: 42 },
      requestBody:
        provider === 'openrouter-decisions'
          ? { provider: { allow_fallbacks: false }, session_id: 'attack-test' }
          : { temperature: 0.3, min_p: 0.05 },
    });
    const preview = await previewRequest(p, problem);
    expect(external).not.toHaveBeenCalled();
    let sent: any;
    const fixture: typeof fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      const choices = Object.keys(problem.options);
      return Response.json(
        provider === 'openrouter-decisions'
          ? {
              model: 'fixture',
              answers: {
                action: {
                  type: 'choice',
                  choice: choices[0],
                  probabilities: Object.fromEntries(choices.map((c, i) => [c, i ? 0 : 1])),
                },
              },
            }
          : {
              id: 'fixture',
              model: 'fixture',
              created: 1,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: JSON.stringify({ choice: choices[0] }) },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
      );
    };
    await createAgent(p.id, [p], 'x', fixture).decide(problem, AbortSignal.timeout(2000));
    expect(preview.body).toEqual(sent);
    expect(JSON.stringify(preview)).not.toContain(p.apiKey);
    const instruction = `${ATTACK_PROMPTS.instruction}\n\n${p.additionalInstructions}`;
    if (provider === 'openrouter-decisions') {
      expect(sent.questions.action.instructions).toBe(instruction);
      expect(sent.state.strategy).toEqual(ATTACK_PROMPTS.strategy);
      expect(sent.provider.allow_fallbacks).toBe(false);
      expect(sent).not.toHaveProperty('max_tokens');
      expect(sent).not.toHaveProperty('reasoning');
    } else {
      expect(sent.messages[0].content).toBe(instruction + OUTPUT_INSTRUCTION);
      expect(JSON.parse(sent.messages[1].content).state.strategy).toEqual(ATTACK_PROMPTS.strategy);
      expect(sent).toMatchObject({
        max_tokens: 321,
        temperature: 0.3,
        top_p: 0.8,
        seed: 42,
        min_p: 0.05,
      });
      expect(sent.response_format.json_schema.schema.properties.choice.enum).toEqual(
        Object.keys(problem.options),
      );
    }
  },
);

it('omits an unset token cap and preserves Gemini response constraints when merging nested parameters', async () => {
  const compatible = await previewRequest(
    profile({ generation: { maxOutputTokens: null } }),
    problem,
  );
  expect(compatible.body).not.toHaveProperty('max_tokens');
  const google = await previewRequest(
    profile({
      provider: 'google',
      baseURL: 'https://example.com/v1beta',
      requestBody: { generationConfig: { temperature: 0.4 } },
    }),
    problem,
  );
  expect(google.body).toHaveProperty('generationConfig.temperature', 0.4);
  expect(google.body).toHaveProperty('generationConfig.responseMimeType', 'application/json');
  expect(google.body).toHaveProperty('generationConfig.responseJsonSchema.properties.choice');
});

it('rejects structural overrides in extra bodies and provider options and redacts nested credentials', async () => {
  for (const body of [
    { model: 'another' },
    { messages: [] },
    { response_format: {} },
    { generationConfig: { responseSchema: {} } },
    { generationConfig: null },
  ]) {
    expect(() => profile({ requestBody: body })).toThrow();
    expect(() => profile({ providerOptions: { compatible: body } })).toThrow();
  }
  const p = profile({
    requestBody: {
      metadata: {
        apiKey: 'extra-key',
        nested: { password: 'extra-password' },
        label: 'experiment',
      },
    },
  });
  const preview = await previewRequest(p, problem);
  expect(JSON.stringify(preview)).not.toContain('extra-key');
  expect(JSON.stringify(preview)).not.toContain('extra-password');
  expect(preview.body).toHaveProperty('metadata.label', 'experiment');
});

it('persists edits, previews unsaved drafts and freezes experiment settings across an entire batch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tetris-experiment-'));
  const store = new SettingsStore(join(dir, 'settings.sqlite'));
  const manager = new Manager(new Artifacts(join(dir, 'results')));
  const app = createApp(manager, store, 4317);
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    app.request('/api' + path, {
      method,
      headers: {
        host: '127.0.0.1:4317',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const settings = ExperimentSchema.parse({
      prompts: ATTACK_PROMPTS,
      timeoutMs: 12300,
      attempts: 2,
    });
    expect((await request('/settings/experiment', settings, 'PUT')).status).toBe(200);
    const provider = store.saveProvider({
      name: 'Fixture',
      kind: 'openai-compatible',
      baseURL: 'http://127.0.0.1:9/v1',
      apiKey: 'saved-key',
    });
    const model = store.saveModel(provider.id, {
      model: 'fixture',
      name: 'Fixture',
      additionalInstructions: 'Saved model instruction',
      generation: { maxOutputTokens: 222 },
      requestBody: { min_p: 0.1 },
    });
    const reopened = new SettingsStore(store.file);
    expect(reopened.experiment()).toEqual(settings);
    expect(reopened.get(model.id)).toMatchObject({
      additionalInstructions: 'Saved model instruction',
      generation: { maxOutputTokens: 222 },
      requestBody: { min_p: 0.1 },
    });
    reopened.close();
    const { id: _id, providerId: _providerId, ...draft } = model;
    const preview = await request('/settings/preview', {
      modelId: model.id,
      model: { ...draft, additionalInstructions: 'Unsaved draft' },
      experiment: { ...settings, prompts: { ...settings.prompts, instruction: 'Unsaved common' } },
    });
    expect(preview.status).toBe(200);
    expect((await preview.json()).body.messages[0].content).toContain(
      'Unsaved common\n\nUnsaved draft',
    );
    expect(store.model(model.id).additionalInstructions).toBe('Saved model instruction');
    expect(store.experiment()).toEqual(settings);
    const idle = once(manager, 'idle');
    const started = await request('/bench', {
      models: ['heuristic', 'random'],
      seeds: ['experiment'],
      run: { mode: 'decision', maxTurns: 1, decisionStepMs: 0, attempts: 1 },
    });
    expect(started.status).toBe(201);
    store.saveExperiment({ prompts: { instruction: 'Next batch only' } });
    await idle;
    const summaries = await manager.artifacts.list();
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      const metadata = JSON.parse(await manager.artifacts.read(summary.id, 'metadata.json'));
      expect(metadata.experiment).toEqual({ ...settings, attempts: 1 });
      expect(summary.config.timeoutMs).toBe(12300);
      expect(summary.config.attempts).toBe(1);
      expect(summary.config).not.toHaveProperty('prompts');
    }
    // Metadata contains experiment parameters but strips all credential fields.
    const p = store.get(model.id);
    p.requestBody = { nested: { apiKey: 'must-not-export', value: 3 } };
    manager.artifacts.metadata('11111111-1111-1111-1111-111111111111', [p], settings);
    await manager.artifacts.flush();
    const metadata = await manager.artifacts.read(
      '11111111-1111-1111-1111-111111111111',
      'metadata.json',
    );
    expect(metadata).not.toContain('must-not-export');
    expect(metadata).not.toContain('saved-key');
    expect(JSON.parse(metadata).connections[0]).toMatchObject({
      additionalInstructions: 'Saved model instruction',
      generation: { maxOutputTokens: 222 },
    });
    const invalid = await request('/settings/experiment', { ...settings, attempts: 99 }, 'PUT');
    expect(invalid.status).toBe(400);
    expect(store.experiment().prompts.instruction).toBe('Next batch only');
  } finally {
    await manager.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
