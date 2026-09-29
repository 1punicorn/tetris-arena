import type { Profile } from './config.js';

export const providerPresets = [
  { kind: 'openai', name: 'OpenAI', provider: 'openai', baseURL: 'https://api.openai.com/v1' },
  {
    kind: 'anthropic',
    name: 'Anthropic · Claude',
    provider: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
  },
  {
    kind: 'google',
    name: 'Google · Gemini',
    provider: 'google',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  },
  {
    kind: 'openrouter',
    name: 'OpenRouter',
    provider: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
  },
  {
    kind: 'ollama',
    name: 'Ollama',
    provider: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
  },
  {
    kind: 'vllm',
    name: 'vLLM',
    provider: 'openai-compatible',
    baseURL: 'http://localhost:8000/v1',
  },
  {
    kind: 'openai-compatible',
    name: 'OpenAI-compatible',
    provider: 'openai-compatible',
    baseURL: '',
  },
  {
    kind: 'anthropic-compatible',
    name: 'Anthropic-compatible',
    provider: 'anthropic',
    baseURL: '',
  },
  { kind: 'azure', name: 'Azure OpenAI', provider: 'azure', baseURL: '' },
  { kind: 'bedrock', name: 'Amazon Bedrock', provider: 'bedrock', baseURL: '' },
  { kind: 'vertex', name: 'Google Vertex', provider: 'vertex', baseURL: '' },
] as const satisfies readonly {
  kind: string;
  name: string;
  provider: Profile['provider'];
  baseURL: string;
}[];
export type ProviderKind = (typeof providerPresets)[number]['kind'];
export const presetFor = (kind: ProviderKind) => providerPresets.find((p) => p.kind === kind)!;
export type CatalogModel = {
  id: string;
  name: string;
  contextLength?: number;
  description?: string;
  api: 'default' | 'decisions';
  supported: boolean;
};
export type Catalog = { models: CatalogModel[]; supported: boolean; truncated: boolean };
