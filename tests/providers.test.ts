import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createAgent, boundedFetch, discover } from '../src/providers/agents.js';
import { ProfileSchema, validateEndpoint } from '../src/providers/config.js';
import { safeError } from '../src/core/errors.js';
import { buildCandidates } from '../src/core/ai-candidates.js';
import { startGame } from '../src/core/engine.js';
import { makeProblem } from '../src/core/observation.js';
import { random } from '../src/core/random.js';

const game = startGame(random('protocol'));
const problem = makeProblem(game, game, buildCandidates(game), 'options', 'decision');
let servers: Server[] = [];
afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  servers = [];
  vi.unstubAllEnvs();
});
async function mock(
  handler: (
    body: any,
    path: string,
  ) => { status?: number; body: unknown; headers?: Record<string, string> },
) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const data of req) raw += data;
    const result = handler(raw ? JSON.parse(raw) : null, req.url!);
    res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json', ...result.headers });
    res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
const profile = (baseURL: string, extra = {}) =>
  ProfileSchema.parse({
    id: 'local',
    name: 'Local',
    provider: 'openai-compatible',
    baseURL,
    model: 'fixture-model',
    reasoningOffSupported: true,
    ...extra,
  });
const completion = (content: string) => ({
  id: 'fixture',
  model: 'actual-model',
  created: 1,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 200, completion_tokens: 8, total_tokens: 208 },
});
describe('provider protocols', () => {
  it('uses the actual SDK over HTTP with strict schema, reasoning off and no hidden retries', async () => {
    let calls = 0;
    const url = await mock((body, path) => {
      calls++;
      expect(path).toBe('/v1/chat/completions');
      expect(body.reasoning_effort).toBe('none');
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.schema.properties.choice.enum).toEqual(
        Object.keys(problem.options),
      );
      expect(body.messages[1].content).toContain('board');
      return { body: completion('{"choice":"option_0"}') };
    });
    const result = await createAgent('local', [profile(url)], '1').decide(
      problem,
      AbortSignal.timeout(2000),
    );
    expect(result.choice).toBe('option_0');
    expect(result.model).toBe('actual-model');
    expect(result.inputTokens).toBe(200);
    expect(calls).toBe(1);
  });
  it('accepts strict JSON text for servers without schema decoding', async () => {
    const url = await mock(() => ({ body: completion('{"choice":"option_1"}') }));
    const result = await createAgent('local', [profile(url, { output: 'json-text' })], '1').decide(
      problem,
      AbortSignal.timeout(2000),
    );
    expect(result.choice).toBe('option_1');
  });
  it.each([
    '{"choice":"invented"}',
    'Sure! {"choice":"option_0"}',
    '{"choice":"option_0","extra":true}',
  ])('rejects invalid output without repairing: %s', async (content) => {
    let calls = 0;
    const url = await mock(() => {
      calls++;
      return { body: completion(content) };
    });
    await expect(
      createAgent('local', [profile(url, { output: 'json-text' })], '1').decide(
        problem,
        AbortSignal.timeout(2000),
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('passes provider-specific options using the official compatibility extension', async () => {
    const url = await mock((body) => {
      expect(body.think).toBe(false);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      return { body: completion('{"choice":"option_0"}') };
    });
    await createAgent(
      'local',
      [
        profile(url, {
          providerOptions: {
            compatible: { think: false, chat_template_kwargs: { enable_thinking: false } },
          },
        }),
      ],
      '1',
    ).decide(problem, AbortSignal.timeout(2000));
  });
  it('validates native Decisions and preserves identical state/choices', async () => {
    const p = ProfileSchema.parse({
      id: 'jev',
      name: 'Jev',
      provider: 'openrouter-decisions',
      model: 'fixture/decision',
    });
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://openrouter.ai/api/alpha/decisions');
      const request = JSON.parse(init!.body as string);
      expect(request.state).toEqual(problem.state);
      expect(request.questions.action.criteria).toEqual(problem.options);
      return Response.json({
        model: 'fixture/actual',
        answers: {
          action: {
            type: 'choice',
            choice: 'option_0',
            probabilities: Object.fromEntries(
              Object.keys(problem.options).map((k) => [k, k === 'option_0' ? 1 : 0]),
            ),
          },
        },
        usage: { input_tokens: 100, output_tokens: 1, cost: 0.0001 },
      });
    });
    const result = await createAgent('jev', [p], '1', transport).decide(
      problem,
      AbortSignal.timeout(2000),
    );
    expect(result.choice).toBe('option_0');
    expect(result.cost).toBe(0.0001);
  });
  it('rejects reported reasoning when the profile requires it off', async () => {
    const url = await mock(() => ({
      body: {
        ...completion('{"choice":"option_0"}'),
        usage: {
          prompt_tokens: 200,
          completion_tokens: 18,
          total_tokens: 218,
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      },
    }));
    await expect(
      createAgent('local', [profile(url)], '1').decide(problem, AbortSignal.timeout(2000)),
    ).rejects.toThrow('reasoning_off_violated');
  });
  it('fails closed when reasoning-off capability is not confirmed', () => {
    expect(() =>
      createAgent(
        'local',
        [profile('http://127.0.0.1:8000/v1', { reasoningOffSupported: false })],
        '1',
      ),
    ).toThrow('reasoning_off_not_confirmed');
  });
  it('sanitizes HTTP errors and never retries 503 inside the SDK', async () => {
    let calls = 0;
    const url = await mock(() => {
      calls++;
      return { status: 503, body: { error: 'PRIVATE_TOKEN_AND_PROMPT' } };
    });
    try {
      await createAgent('local', [profile(url)], '1').decide(problem, AbortSignal.timeout(2000));
      throw new Error('expected failure');
    } catch (e) {
      expect(safeError(e)).toBe('http_503');
    }
    expect(calls).toBe(1);
  });
  it('bounds response size and blocks redirects', async () => {
    const url = await mock((_, path) =>
      path.endsWith('large')
        ? { body: 'x'.repeat(1048577) }
        : { status: 302, headers: { location: 'https://example.com' }, body: '' },
    );
    await expect(boundedFetch(url + '/large')).rejects.toThrow('response_too_large');
    await expect(boundedFetch(url + '/redirect')).rejects.toThrow();
  });
  it('discovers model IDs without inference', async () => {
    const url = await mock((body, path) => {
      expect(body).toBeNull();
      expect(path).toBe('/v1/models');
      return { body: { data: [{ id: 'another-model' }] } };
    });
    expect(await discover(profile(url), AbortSignal.timeout(2000))).toEqual([
      'fixture-model',
      'another-model',
    ]);
  });
  it('only permits private HTTP endpoints or HTTPS and rejects embedded credentials', () => {
    expect(() => validateEndpoint('http://example.com/v1')).toThrow();
    expect(() => validateEndpoint('https://user:secret@example.com/v1')).toThrow();
    expect(() => validateEndpoint('http://192.168.1.8:8000/v1')).not.toThrow();
  });
});
