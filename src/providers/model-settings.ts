import { z } from 'zod';

// These fields belong to the engine's request/response contract. Everything else
// may be supplied explicitly; the endpoint remains responsible for accepting it.
export const RESERVED_BODY_KEYS = new Set([
  'model',
  'models',
  'messages',
  'input',
  'prompt',
  'system',
  'instructions',
  'contents',
  'systemInstruction',
  'system_instruction',
  'state',
  'questions',
  'stream',
  'stream_options',
  'n',
  'response_format',
  'output',
  'output_config',
  'outputConfig',
  'responseFormat',
  'responseSchema',
  'responseJsonSchema',
  'responseMimeType',
  'response_schema',
  'response_mime_type',
  'text',
  'tools',
  'tool_choice',
  'toolConfig',
  'tool_config',
  '__proto__',
  'constructor',
  'prototype',
]);
export const RequestBodySchema = z
  .record(z.string(), z.unknown())
  .default({})
  .superRefine((value, ctx) => {
    const check = (item: unknown, path: string[]) => {
      if (!item || typeof item !== 'object') return;
      for (const [key, child] of Object.entries(item)) {
        if (RESERVED_BODY_KEYS.has(key))
          ctx.addIssue({
            code: 'custom',
            path: [...path, key],
            message: `Engine-managed request field: ${key}`,
          });
        else check(child, [...path, key]);
        if (
          ['generationConfig', 'generation_config', 'inferenceConfig'].includes(key) &&
          (!child || typeof child !== 'object' || Array.isArray(child))
        )
          ctx.addIssue({
            code: 'custom',
            path: [...path, key],
            message: 'Generation configuration must be an object',
          });
      }
    };
    check(value, []);
    if (JSON.stringify(value).length > 32000)
      ctx.addIssue({ code: 'custom', message: 'Request parameters are too large' });
  });
export const ProviderOptionsSchema = z.record(z.string(), RequestBodySchema).default({});
export const GenerationSchema = z
  .object({
    maxOutputTokens: z.number().int().min(1).max(1000000).nullable().default(1024),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().int().min(1).optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    seed: z.number().int().min(-2147483648).max(2147483647).optional(),
    stopSequences: z.array(z.string().min(1).max(256)).max(16).optional(),
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('medium'),
  })
  .strict();
export const modelExperimentFields = {
  additionalInstructions: z.string().max(16000).default(''),
  generation: GenerationSchema.default(GenerationSchema.parse({})),
  requestBody: RequestBodySchema,
};

// Arbitrary provider parameters can contain credentials. Never publish those in
// previews or downloadable experiment records, including nested header values.
export function redactParameters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactParameters);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /authorization|api.?key|secret|password|credential|headers|access.?token|refresh.?token/i.test(
        key,
      )
        ? '[redacted]'
        : redactParameters(item),
    ]),
  );
}
