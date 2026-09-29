import { z } from 'zod';
import { providerPresets, type ProviderKind } from './presets.js';
import { modelExperimentFields, ProviderOptionsSchema } from './model-settings.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const ProviderInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(providerPresets.map((p) => p.kind) as [ProviderKind, ...ProviderKind[]]),
    baseURL: z.string().url().optional(),
    apiKey: z.string().min(1).max(8192).optional(),
    clearApiKey: z.boolean().default(false),
    region: z.string().max(120).optional(),
    project: z.string().max(120).optional(),
    location: z.string().max(120).optional(),
    resourceName: z.string().max(120).optional(),
    apiVersion: z.string().max(120).optional(),
  })
  .strict();
export type ProviderInput = z.infer<typeof ProviderInputSchema>;
export const StoredProviderSchema = ProviderInputSchema.omit({ clearApiKey: true }).extend({
  id,
  apiKeyEnv: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional(),
});
export type StoredProvider = z.infer<typeof StoredProviderSchema>;
export type EditableProvider = Omit<StoredProvider, 'apiKey' | 'apiKeyEnv'> & {
  hasApiKey: boolean;
  modelCount: number;
  enabledCount: number;
};
export const ModelInputSchema = z
  .object({
    ...modelExperimentFields,
    model: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean().default(true),
    api: z.enum(['default', 'decisions']).default('default'),
    reasoning: z.enum(['off', 'on', 'provider-default']).default('provider-default'),
    reasoningOffSupported: z.boolean().default(false),
    output: z.enum(['schema', 'json-text']).default('schema'),
    providerOptions: ProviderOptionsSchema,
  })
  .strict();
export type ModelInput = z.infer<typeof ModelInputSchema>;
export const StoredModelSchema = ModelInputSchema.extend({ id, providerId: id });
export type StoredModel = z.infer<typeof StoredModelSchema>;
export const ModelSelectionSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            model: z.string().trim().min(1).max(256),
            name: z.string().trim().min(1).max(120).optional(),
            api: z.enum(['default', 'decisions']).default('default'),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
