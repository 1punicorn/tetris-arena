import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import { discoverCatalog } from '../src/providers/catalog.js';
import type { ProviderKind } from '../src/providers/presets.js';
import type { StoredProvider } from '../src/providers/registry.js';
import { safeError } from '../src/core/errors.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers.length = 0;
});
async function fixture(
  kind: ProviderKind,
  handler: (req: IncomingMessage) => unknown,
): Promise<StoredProvider> {
  const s = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(handler(req)));
  });
  servers.push(s);
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  return {
    id: 'fixture',
    kind,
    name: 'Fixture',
    apiKey: 'catalog-secret',
    baseURL: `http://127.0.0.1:${(s.address() as { port: number }).port}/v1`,
  };
}
const list = (p: StoredProvider) => discoverCatalog(p, AbortSignal.timeout(3000));
describe('provider model catalogs', () => {
  it.each(['openai', 'openai-compatible', 'ollama', 'vllm'] as ProviderKind[])(
    'discovers %s using the configured endpoint and a single shared key',
    async (kind) => {
      const p = await fixture(kind, (req) => {
        expect(req.url).toBe('/v1/models');
        expect(req.headers.authorization).toBe('Bearer catalog-secret');
        return { data: [{ id: 'first' }, { id: 'second' }] };
      });
      expect(await list(p)).toMatchObject({
        supported: true,
        truncated: false,
        models: [{ id: 'first', api: 'default' }, { id: 'second' }],
      });
    },
  );
  it.each(['anthropic', 'anthropic-compatible'] as ProviderKind[])(
    'paginates %s with Messages API authentication',
    async (kind) => {
      const cursors: (string | null)[] = [];
      const p = await fixture(kind, (req) => {
        expect(req.headers['x-api-key']).toBe('catalog-secret');
        expect(req.headers['anthropic-version']).toBe('2023-06-01');
        const cursor = new URL(req.url!, 'http://local').searchParams.get('after_id');
        cursors.push(cursor);
        return cursor
          ? { data: [{ id: 'claude-b', display_name: 'Claude B' }], has_more: false }
          : {
              data: [{ id: 'claude-a', display_name: 'Claude A', max_input_tokens: 200000 }],
              has_more: true,
              last_id: 'claude-a',
            };
      });
      expect((await list(p)).models).toMatchObject([
        { id: 'claude-a', name: 'Claude A', contextLength: 200000 },
        { id: 'claude-b', name: 'Claude B' },
      ]);
      expect(cursors).toEqual([null, 'claude-a']);
    },
  );
  it('paginates Gemini and identifies models that cannot generate text', async () => {
    const p = await fixture('google', (req) => {
      expect(req.headers['x-goog-api-key']).toBe('catalog-secret');
      return new URL(req.url!, 'http://local').searchParams.has('pageToken')
        ? { models: [{ name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] }
        : {
            models: [
              {
                name: 'models/gemini-test',
                displayName: 'Gemini test',
                inputTokenLimit: 1000000,
                supportedGenerationMethods: ['generateContent'],
              },
            ],
            nextPageToken: 'next',
          };
    });
    expect((await list(p)).models).toMatchObject([
      { id: 'gemini-test', supported: true, contextLength: 1000000 },
      { id: 'embed', supported: false },
    ]);
  });
  it('fetches OpenRouter pages including Decisions and excludes unsupported output types from selection', async () => {
    const offsets: string[] = [];
    const p = await fixture('openrouter', (req) => {
      const params = new URL(req.url!, 'http://local').searchParams;
      expect(params.get('output_modalities')).toBe('all');
      offsets.push(params.get('offset')!);
      if (params.get('offset') === '0')
        return {
          data: Array.from({ length: 100 }, (_, i) => ({
            id: `text-${i}`,
            architecture: { output_modalities: ['text'] },
          })),
        };
      return {
        data: [
          { id: 'solar', name: 'Solar', architecture: { output_modalities: ['decisions'] } },
          { id: 'image', architecture: { output_modalities: ['image'] } },
          { id: 'text-0' },
        ],
      };
    });
    const result = await list(p);
    expect(offsets).toEqual(['0', '100']);
    expect(result.models).toHaveLength(102);
    expect(result.models.find((m) => m.id === 'solar')).toMatchObject({
      api: 'decisions',
      supported: true,
    });
    expect(result.models.find((m) => m.id === 'image')).toMatchObject({ supported: false });
  });
  it('rejects repeated cursors and returns manual registration for cloud deployment IDs', async () => {
    const p = await fixture('anthropic', () => ({
      data: [{ id: 'same' }],
      has_more: true,
      last_id: 'same',
    }));
    await expect(list(p)).rejects.toThrow('invalid_catalog_pagination');
    for (const kind of ['azure', 'bedrock', 'vertex'] as const)
      expect(await list({ ...p, kind })).toEqual({
        models: [],
        supported: false,
        truncated: false,
      });
  });
  it('does not expose provider error bodies or credentials', async () => {
    const s = createServer((_req, res) => {
      res.writeHead(401);
      res.end('secret provider message catalog-secret');
    });
    servers.push(s);
    s.listen(0, '127.0.0.1');
    await once(s, 'listening');
    try {
      await list({
        id: 'test',
        kind: 'openai',
        name: 'Test',
        apiKey: 'catalog-secret',
        baseURL: `http://127.0.0.1:${(s.address() as { port: number }).port}`,
      });
      throw new Error('expected rejection');
    } catch (e) {
      expect(safeError(e)).toBe('http_401');
    }
  });
});
