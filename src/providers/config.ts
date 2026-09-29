import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ModelError } from '../core/errors.js';

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
    apiKey: z.string().min(1).max(8192).optional(),
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
export const ConnectionInputSchema = ProfileSchema.omit({ id: true, apiKeyEnv: true }).extend({
  clearApiKey: z.boolean().default(false),
});
export type ConnectionInput = z.infer<typeof ConnectionInputSchema>;
export type EditableConnection = Omit<Profile, 'apiKey' | 'apiKeyEnv'> & {
  hasApiKey: boolean;
  credentialSource: 'saved' | 'environment' | 'none';
};
export function apiKeyFor(profile: Profile) {
  return profile.apiKey ?? (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined);
}
export function editableProfile(profile: Profile): EditableConnection {
  const { apiKey, apiKeyEnv, ...visible } = profile;
  return {
    ...visible,
    hasApiKey: !!apiKeyFor(profile),
    credentialSource: apiKey ? 'saved' : apiKeyEnv ? 'environment' : 'none',
  };
}
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
    throw new ModelError('invalid_endpoint');
  const host = url.hostname;
  const local =
    host === 'localhost' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.local');
  if (url.protocol === 'http:' && !local) throw new ModelError('remote_endpoint_requires_https');
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
  validateProfiles(connections);
  return connections;
}
export function validateProfiles(connections: Profile[]) {
  const ids = new Set<string>([...baselines.map((b) => b.id), 'human', 'none']);
  for (const profile of connections) {
    if (ids.has(profile.id)) throw new ModelError('duplicate_connection');
    ids.add(profile.id);
    if (profile.baseURL) validateEndpoint(profile.baseURL);
    if (
      profile.provider === 'openrouter-decisions' &&
      profile.baseURL &&
      profile.baseURL !== 'https://openrouter.ai/api/v1'
    )
      throw new ModelError('unsupported_decision_endpoint');
    if (profile.provider === 'openai-compatible' && !profile.baseURL)
      throw new ModelError('missing_base_url');
  }
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
      (!(
        p.apiKeyEnv ||
        ['openrouter-decisions', 'openai', 'anthropic', 'google', 'azure'].includes(p.provider)
      ) ||
        !!apiKeyFor(p)) &&
      (p.provider === 'openrouter-decisions' || p.reasoning !== 'off' || p.reasoningOffSupported),
  };
}
