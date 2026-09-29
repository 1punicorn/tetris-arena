import { generateText, Output, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createAzure } from '@ai-sdk/azure';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createGoogleVertex } from '@ai-sdk/google-vertex';
import { z } from 'zod';
import type { DecisionAgent, DecisionProblem, DecisionResult } from '../core/types.js';
import { random } from '../core/random.js';
import { type Profile, validateEndpoint } from './config.js';

import { ModelError } from '../core/errors.js';
export const boundedFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  validateEndpoint(url.split('?')[0]);
  if (typeof init?.body === 'string' && Buffer.byteLength(init.body) > 262144)
    throw new ModelError('request_too_large');
  const response = await fetch(input, { ...init, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelError(`http_${response.status}`);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1048576) throw new ModelError('response_too_large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(response.status === 204 ? null : Buffer.concat(chunks), {
    status: response.status,
    headers,
  });
};
function languageModel(profile: Profile, transport: typeof fetch): LanguageModel {
  const settings = {
    apiKey: profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined,
    baseURL: profile.baseURL,
    fetch: transport,
  };
  switch (profile.provider) {
    case 'openai':
      return createOpenAI(settings)(profile.model);
    case 'openai-compatible':
      return createOpenAICompatible({
        ...settings,
        name: 'compatible',
        baseURL: profile.baseURL!,
        supportsStructuredOutputs: profile.output === 'schema',
      }).chatModel(profile.model);
    case 'anthropic':
      return createAnthropic(settings)(profile.model);
    case 'google':
      return createGoogle(settings)(profile.model);
    case 'azure':
      return createAzure({
        ...settings,
        resourceName: profile.resourceName,
        apiVersion: profile.apiVersion,
      })(profile.model);
    case 'bedrock':
      return createAmazonBedrock({ ...settings, region: profile.region })(profile.model);
    case 'vertex':
      return createGoogleVertex({
        ...settings,
        project: profile.project,
        location: profile.location,
      })(profile.model);
    default:
      throw new ModelError('not_a_language_model');
  }
}
export function createAgent(
  id: string,
  profiles: Profile[],
  seed: string,
  transport: typeof fetch = boundedFetch,
): DecisionAgent {
  const rng = random(`${seed}:${id}`);
  if (id === 'random' || id === 'heuristic')
    return {
      id,
      async decide(problem, signal) {
        signal.throwIfAborted();
        const keys = Object.keys(problem.candidates);
        const choice =
          id === 'random'
            ? keys[Math.floor(rng() * keys.length)]
            : keys.sort((a, b) => {
                const x = problem.candidates[a],
                  y = problem.candidates[b];
                return (
                  x.holes - y.holes ||
                  x.max_height - y.max_height ||
                  y.cleared_lines - x.cleared_lines ||
                  x.bumpiness - y.bumpiness ||
                  x.key_presses - y.key_presses
                );
              })[0];
        return { choice, model: id, provider: 'baseline', latencyMs: 0 };
      },
    };
  const profile = profiles.find((p) => p.id === id);
  if (!profile) throw new ModelError('unknown_connection');
  if (profile.apiKeyEnv && !process.env[profile.apiKeyEnv])
    throw new ModelError('missing_credential');
  if (
    profile.provider !== 'openrouter-decisions' &&
    profile.reasoning === 'off' &&
    !profile.reasoningOffSupported
  )
    throw new ModelError('reasoning_off_not_confirmed');
  return {
    id,
    async decide(problem: DecisionProblem, signal: AbortSignal): Promise<DecisionResult> {
      signal.throwIfAborted();
      const started = performance.now();
      const choices = Object.keys(problem.options);
      if (choices.length < 2) throw new ModelError('requires_multiple_choices');
      if (profile.provider === 'openrouter-decisions') {
        const response = await transport('https://openrouter.ai/api/alpha/decisions', {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env[profile.apiKeyEnv ?? 'OPENROUTER_API_KEY'] ?? ''}`,
          },
          body: JSON.stringify({
            model: profile.model,
            state: problem.state,
            questions: {
              action: {
                type: 'choice',
                instructions: problem.instruction,
                criteria: problem.options,
              },
            },
          }),
        });
        const schema = z.object({
          model: z.string(),
          answers: z.object({
            action: z.object({
              type: z.literal('choice'),
              choice: z.enum(choices as [string, ...string[]]),
              probabilities: z.record(z.string(), z.number().min(0).max(1)),
            }),
          }),
          usage: z
            .object({
              input_tokens: z.number().nonnegative().optional(),
              output_tokens: z.number().nonnegative().optional(),
              cost: z.number().nonnegative().optional(),
            })
            .optional(),
        });
        const data = schema.parse(await response.json()),
          distribution = data.answers.action.probabilities;
        if (
          Object.keys(distribution).length !== choices.length ||
          choices.some((k) => !(k in distribution)) ||
          Math.abs(Object.values(distribution).reduce((a, b) => a + b, 0) - 1) > 0.01
        )
          throw new ModelError('invalid_distribution');
        return {
          choice: data.answers.action.choice,
          model: data.model,
          provider: profile.provider,
          latencyMs: performance.now() - started,
          inputTokens: data.usage?.input_tokens,
          outputTokens: data.usage?.output_tokens,
          cost: data.usage?.cost,
        };
      }
      const schema = z.object({ choice: z.enum(choices as [string, ...string[]]) }).strict();
      const result = await generateText({
        model: languageModel(profile, transport),
        maxRetries: 0,
        abortSignal: signal,
        maxOutputTokens: 1024,
        reasoning:
          profile.reasoning === 'off'
            ? 'none'
            : profile.reasoning === 'on'
              ? 'medium'
              : 'provider-default',
        providerOptions: profile.providerOptions as NonNullable<
          Parameters<typeof generateText>[0]['providerOptions']
        >,
        system:
          problem.instruction +
          ' Return only JSON with one key "choice" containing an offered option ID.',
        prompt: JSON.stringify({ state: problem.state, options: problem.options }),
        ...(profile.output === 'schema' ? { output: Output.object({ schema }) } : {}),
      });
      if (
        profile.reasoning === 'off' &&
        result.warnings?.some(
          (w) =>
            (w.type === 'unsupported' || w.type === 'compatibility') &&
            JSON.stringify(w).toLowerCase().includes('reasoning'),
        )
      )
        throw new ModelError('reasoning_off_unsupported');
      if (
        profile.reasoning === 'off' &&
        ((result.usage.outputTokenDetails?.reasoningTokens ?? 0) > 0 || result.reasoningText)
      )
        throw new ModelError('reasoning_off_violated');
      const output = schema.parse(
        profile.output === 'schema' ? result.output : JSON.parse(result.text),
      );
      return {
        choice: output.choice,
        model: result.response.modelId,
        provider: profile.provider,
        latencyMs: performance.now() - started,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens,
      };
    },
  };
}

/** Inventory requests never perform inference. Manual IDs remain valid when discovery is unsupported. */
export async function discover(profile: Profile, signal: AbortSignal): Promise<string[]> {
  const key = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  const headers: Record<string, string> = {};
  let url: string;
  switch (profile.provider) {
    case 'openrouter-decisions':
      url = 'https://openrouter.ai/api/v1/models?output_modalities=decisions';
      break;
    case 'openai-compatible':
    case 'openai':
      url = (profile.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '') + '/models';
      break;
    case 'anthropic':
      url = (profile.baseURL ?? 'https://api.anthropic.com/v1').replace(/\/$/, '') + '/models';
      headers['anthropic-version'] = '2023-06-01';
      if (key) headers['x-api-key'] = key;
      break;
    case 'google':
      url =
        (profile.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '') +
        '/models';
      if (key) headers['x-goog-api-key'] = key;
      break;
    default:
      return [profile.model];
  }
  if (key && !['anthropic', 'google'].includes(profile.provider))
    headers.Authorization = `Bearer ${key}`;
  const response = await boundedFetch(url, { headers, signal });
  const body = (await response.json()) as { data?: { id: string }[]; models?: { name: string }[] };
  const ids =
    body.data?.map((m) => m.id) ?? body.models?.map((m) => m.name.replace(/^models\//, '')) ?? [];
  return [
    ...new Set([profile.model, ...ids.filter((id) => typeof id === 'string' && id.length <= 256)]),
  ].slice(0, 1000);
}
