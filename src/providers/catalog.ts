import { z } from 'zod';
import { boundedFetch } from './agents.js';
import { presetFor, type Catalog, type CatalogModel } from './presets.js';
import type { StoredProvider } from './registry.js';
import { ModelError } from '../core/errors.js';

const rowSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    display_name: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().nullable().optional(),
    context_length: z.number().nullable().optional(),
    inputTokenLimit: z.number().optional(),
    max_input_tokens: z.number().nullable().optional(),
    supportedGenerationMethods: z.array(z.string()).optional(),
    architecture: z
      .object({ output_modalities: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const pageSchema = z
  .object({
    data: z.array(rowSchema).optional(),
    models: z.array(rowSchema).optional(),
    has_more: z.boolean().optional(),
    last_id: z.string().nullable().optional(),
    nextPageToken: z.string().optional(),
  })
  .passthrough();

/** Lists catalogs without inference; cursors never change the configured endpoint. */
export async function discoverCatalog(
  provider: StoredProvider,
  signal: AbortSignal,
): Promise<Catalog> {
  if (['azure', 'bedrock', 'vertex'].includes(provider.kind))
    return { models: [], supported: false, truncated: false };
  const protocol = presetFor(provider.kind).provider;
  const base = (provider.baseURL ?? presetFor(provider.kind).baseURL).replace(/\/$/, '');
  const url = new URL(base + '/models');
  const key = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
  const headers: Record<string, string> = {};
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
    url.searchParams.set('limit', '100');
  } else if (protocol === 'google') {
    if (key) headers['x-goog-api-key'] = key;
    url.searchParams.set('pageSize', '100');
  } else if (key) headers.Authorization = `Bearer ${key}`;
  if (provider.kind === 'openrouter') {
    url.searchParams.set('output_modalities', 'all');
    url.searchParams.set('limit', '100');
    url.searchParams.set('offset', '0');
  }
  const models = new Map<string, CatalogModel>();
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    signal.throwIfAborted();
    if (seen.has(url.href)) throw new ModelError('invalid_catalog_pagination');
    seen.add(url.href);
    const response = await boundedFetch(url.href, { headers, signal });
    const body = pageSchema.parse(await response.json());
    const rows = body.data ?? body.models;
    if (!rows) throw new ModelError('invalid_model_catalog');
    for (const row of rows) {
      const id = protocol === 'google' ? row.name?.replace(/^models\//, '') : row.id;
      if (!id || id.length > 256) continue;
      const modalities = row.architecture?.output_modalities;
      const api = modalities?.includes('decisions') ? 'decisions' : 'default';
      const supported =
        protocol === 'google' && row.supportedGenerationMethods
          ? row.supportedGenerationMethods.includes('generateContent')
          : !modalities || modalities.includes('text') || modalities.includes('decisions');
      models.set(id, {
        id,
        name: (
          row.display_name ??
          row.displayName ??
          (protocol === 'google' ? undefined : row.name) ??
          id
        ).slice(0, 160),
        description: row.description?.slice(0, 400),
        contextLength:
          row.context_length ?? row.inputTokenLimit ?? row.max_input_tokens ?? undefined,
        api: provider.kind === 'openrouter' ? api : 'default',
        supported,
      });
    }
    let more = false;
    if (protocol === 'google' && body.nextPageToken) {
      url.searchParams.set('pageToken', body.nextPageToken);
      more = true;
    } else if (protocol === 'anthropic' && body.has_more) {
      const cursor = body.last_id ?? rows.at(-1)?.id;
      if (!cursor) throw new ModelError('invalid_catalog_pagination');
      url.searchParams.set('after_id', cursor);
      more = true;
    } else if (provider.kind === 'openrouter' && rows.length === 100) {
      url.searchParams.set('offset', String((page + 1) * 100));
      more = true;
    }
    if (!more) return { models: [...models.values()], supported: true, truncated: false };
    if (models.size >= 10000) break;
  }
  return { models: [...models.values()].slice(0, 10000), supported: true, truncated: true };
}
