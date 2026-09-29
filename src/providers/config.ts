import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export const ProfileSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    name: z.string().min(1).max(120),
    provider: z.enum([
      'openrouter-decisions',
      'openai-compatible',
      'openai',
      'anthropic',
      'google',
      'azure',
      'bedrock',
      'vertex',
    ]),
    baseURL: z.string().url().optional(),
    model: z.string().min(1).max(256),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    reasoning: z.enum(['off', 'on', 'provider-default']).default('off'),
    // Compatibility is a property of an endpoint/model, not its name.
    reasoningOffSupported: z.boolean().default(false),
    output: z.enum(['schema', 'json-text']).default('schema'),
    providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    region: z.string().optional(),
    project: z.string().optional(),
    location: z.string().optional(),
    resourceName: z.string().optional(),
    apiVersion: z.string().optional(),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;
export const ConfigSchema = z.object({ connections: z.array(ProfileSchema).max(100) }).strict();
export const baselines = [
  {
    id: 'heuristic',
    name: 'Heuristic baseline',
    provider: 'baseline',
    model: 'heuristic',
    reasoning: 'off',
    available: true,
  },
  {
    id: 'random',
    name: 'Seeded random',
    provider: 'baseline',
    model: 'random',
    reasoning: 'off',
    available: true,
  },
];
export function validateEndpoint(address: string) {
  const url = new URL(address);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('invalid_endpoint');
  const host = url.hostname;
  const local =
    host === 'localhost' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.local');
  if (url.protocol === 'http:' && !local) throw new Error('remote_endpoint_requires_https');
  return url;
}
export async function loadProfiles(file = 'connections.local.json'): Promise<Profile[]> {
  let data: string;
  try {
    data = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  if (Buffer.byteLength(data) > 128 * 1024) throw new Error('configuration_too_large');
  const { connections } = ConfigSchema.parse(JSON.parse(data));
  const ids = new Set<string>(baselines.map((b) => b.id));
  for (const profile of connections) {
    if (ids.has(profile.id)) throw new Error('duplicate_connection');
    ids.add(profile.id);
    if (profile.baseURL) validateEndpoint(profile.baseURL);
    if (
      profile.provider === 'openrouter-decisions' &&
      profile.baseURL &&
      profile.baseURL !== 'https://openrouter.ai/api/v1'
    )
      throw new Error('unsupported_decision_endpoint');
    if (profile.provider === 'openai-compatible' && !profile.baseURL)
      throw new Error('missing_base_url');
  }
  return connections;
}
export function publicProfile(p: Profile) {
  return {
    id: p.id,
    name: p.name,
    provider: p.provider,
    model: p.model,
    reasoning: p.reasoning,
    output: p.output,
    available:
      (!p.apiKeyEnv || !!process.env[p.apiKeyEnv]) &&
      (p.provider === 'openrouter-decisions' || p.reasoning !== 'off' || p.reasoningOffSupported),
  };
}
