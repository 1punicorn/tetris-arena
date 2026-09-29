import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, openSync, closeSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  apiKeyFor,
  ConnectionInputSchema,
  editableProfile,
  loadProfiles,
  ProfileSchema,
  publicProfile,
  validateEndpoint,
  validateProfiles,
  type Profile,
} from '../providers/config.js';
import { presetFor, type ProviderKind } from '../providers/presets.js';
import {
  ProviderInputSchema,
  StoredProviderSchema,
  ModelInputSchema,
  StoredModelSchema,
  ModelSelectionSchema,
  type StoredProvider,
  type StoredModel,
  type EditableProvider,
} from '../providers/registry.js';
import { ModelError } from '../core/errors.js';
import { ExperimentSchema } from '../core/experiment.js';

export class SettingsStore {
  private db: DatabaseSync;
  readonly directory: string;
  constructor(readonly file = 'data/settings.sqlite') {
    this.directory = dirname(resolve(file));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        config TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS models_provider ON models(provider_id);
      DROP TABLE IF EXISTS sessions;
      DELETE FROM settings WHERE key IN ('owner_password', 'setup_hash');
    `);
    rmSync(`${file}.setup-code`, { force: true });
    this.transaction(() => {
      if (
        this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connections'")
          .get()
      ) {
        for (const row of this.db.prepare('SELECT profile FROM connections ORDER BY rowid').all())
          this.importProfile(ProfileSchema.parse(JSON.parse(String(row.profile))));
        this.db.exec('DROP TABLE connections');
      }
    });
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  getSetting(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        { value: string } | undefined
    )?.value;
  }
  setSetting(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  experiment() {
    const saved = this.getSetting('experiment');
    return ExperimentSchema.parse(saved ? JSON.parse(saved) : {});
  }
  saveExperiment(raw: unknown) {
    const settings = ExperimentSchema.parse(raw);
    this.setSetting('experiment', JSON.stringify(settings));
    return settings;
  }
  private allProviders(): StoredProvider[] {
    return this.db
      .prepare('SELECT config FROM providers ORDER BY rowid')
      .all()
      .map((row) => StoredProviderSchema.parse(JSON.parse(String(row.config))));
  }
  provider(id: string): StoredProvider {
    const row = this.db.prepare('SELECT config FROM providers WHERE id=?').get(id);
    if (!row) throw new ModelError('unknown_provider');
    return StoredProviderSchema.parse(JSON.parse(String(row.config)));
  }
  providers(): EditableProvider[] {
    const models = this.models();
    return this.allProviders().map(({ apiKey, apiKeyEnv, ...provider }) => ({
      ...provider,
      hasApiKey: !!(apiKey ?? (apiKeyEnv ? process.env[apiKeyEnv] : undefined)),
      modelCount: models.filter((m) => m.providerId === provider.id).length,
      enabledCount: models.filter((m) => m.providerId === provider.id && m.enabled).length,
    }));
  }
  draftProvider(raw: unknown, id?: string): StoredProvider {
    const { clearApiKey, ...input } = ProviderInputSchema.parse(raw);
    const previous = id ? this.provider(id) : undefined;
    const value = StoredProviderSchema.parse({
      ...input,
      id: id ?? randomUUID(),
      baseURL: (input.baseURL ?? (presetFor(input.kind).baseURL || undefined))?.replace(/\/$/, ''),
      apiKey: clearApiKey ? undefined : (input.apiKey ?? previous?.apiKey),
      apiKeyEnv: clearApiKey || input.apiKey ? undefined : previous?.apiKeyEnv,
    });
    if (value.baseURL) validateEndpoint(value.baseURL);
    if (
      ['openai-compatible', 'anthropic-compatible', 'ollama', 'vllm'].includes(value.kind) &&
      !value.baseURL
    )
      throw new ModelError('missing_base_url');
    return value;
  }
  private putProvider(provider: StoredProvider) {
    this.db
      .prepare(
        'INSERT INTO providers VALUES (?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config',
      )
      .run(provider.id, JSON.stringify(provider));
  }
  saveProvider(raw: unknown, id?: string): EditableProvider {
    const provider = this.draftProvider(raw, id);
    if (!id && this.allProviders().length >= 100) throw new ModelError('provider_limit');
    // Validate existing model protocols before changing a shared connection.
    for (const model of this.models(id).filter((m) => m.providerId === provider.id))
      this.compile(provider, model);
    this.putProvider(provider);
    return this.providers().find((p) => p.id === provider.id)!;
  }
  deleteProvider(id: string) {
    this.provider(id);
    this.db.prepare('DELETE FROM providers WHERE id=?').run(id);
  }
  models(providerId?: string): StoredModel[] {
    const rows = providerId
      ? this.db
          .prepare('SELECT config FROM models WHERE provider_id=? ORDER BY rowid')
          .all(providerId)
      : this.db.prepare('SELECT config FROM models ORDER BY rowid').all();
    return rows.map((row) => StoredModelSchema.parse(JSON.parse(String(row.config))));
  }
  model(id: string): StoredModel {
    const row = this.db.prepare('SELECT config FROM models WHERE id=?').get(id);
    if (!row) throw new ModelError('unknown_connection');
    return StoredModelSchema.parse(JSON.parse(String(row.config)));
  }
  compile(provider: StoredProvider, model: StoredModel): Profile {
    if (model.api === 'decisions' && provider.kind !== 'openrouter')
      throw new ModelError('unsupported_model_protocol');
    const { kind, id: _providerId, name: _providerName, ...credentials } = provider;
    const { providerId: _id, enabled: _enabled, api, ...settings } = model;
    const profile = ProfileSchema.parse({
      ...credentials,
      ...settings,
      provider: api === 'decisions' ? 'openrouter-decisions' : presetFor(kind).provider,
    });
    validateProfiles([profile]);
    return profile;
  }
  private putModel(model: StoredModel) {
    this.db
      .prepare(
        'INSERT INTO models VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,config=excluded.config',
      )
      .run(model.id, model.providerId, JSON.stringify(model));
  }
  saveModel(providerId: string, raw: unknown, id?: string): StoredModel {
    const provider = this.provider(providerId);
    const previous = id ? this.model(id) : undefined;
    if (previous && previous.providerId !== providerId) throw new ModelError('unknown_connection');
    if (!id && (this.models(providerId).length >= 500 || this.models().length >= 5000))
      throw new ModelError('model_limit');
    const model = StoredModelSchema.parse({
      ...ModelInputSchema.parse(raw),
      id: id ?? randomUUID(),
      providerId,
    });
    this.compile(provider, model);
    this.putModel(model);
    return model;
  }
  selectModels(providerId: string, raw: unknown) {
    const { models: selected } = ModelSelectionSchema.parse(raw);
    const key = (m: { model: string; api: string }) => `${m.api}:${m.model}`;
    if (new Set(selected.map(key)).size !== selected.length)
      throw new ModelError('duplicate_model');
    this.provider(providerId);
    return this.transaction(() => {
      const previous = this.models(providerId);
      const selection = new Set(selected.map(key));
      for (const model of previous) this.putModel({ ...model, enabled: selection.has(key(model)) });
      for (const input of selected) {
        if (!previous.some((m) => key(m) === key(input)))
          this.saveModel(providerId, { ...input, name: input.name ?? input.model.slice(0, 120) });
      }
      return this.models(providerId);
    });
  }
  profiles(): Profile[] {
    const providers = new Map(this.allProviders().map((p) => [p.id, p]));
    return this.models()
      .filter((m) => m.enabled)
      .map((m) => this.compile(providers.get(m.providerId)!, m));
  }
  publicModels() {
    const providers = new Map(this.allProviders().map((p) => [p.id, p]));
    return this.models()
      .filter((m) => m.enabled)
      .map((m) => ({
        ...publicProfile(this.compile(providers.get(m.providerId)!, m)),
        providerId: m.providerId,
        providerName: providers.get(m.providerId)!.name,
      }));
  }
  get(id: string): Profile {
    const model = this.model(id);
    return this.compile(this.provider(model.providerId), model);
  }
  delete(id: string) {
    this.model(id);
    this.db.prepare('DELETE FROM models WHERE id=?').run(id);
  }
  list() {
    return this.models().map((m) => editableProfile(this.get(m.id)));
  }
  private connectionFrom(profile: Profile): Omit<StoredProvider, 'id'> {
    const {
      provider,
      baseURL,
      apiKey,
      apiKeyEnv,
      region,
      project,
      location,
      resourceName,
      apiVersion,
    } = profile;
    let kind: ProviderKind = provider === 'openrouter-decisions' ? 'openrouter' : provider;
    if (
      provider === 'openai-compatible' &&
      baseURL?.replace(/\/$/, '') === 'https://openrouter.ai/api/v1'
    )
      kind = 'openrouter';
    if (
      provider === 'anthropic' &&
      baseURL &&
      baseURL.replace(/\/$/, '') !== presetFor('anthropic').baseURL
    )
      kind = 'anthropic-compatible';
    return {
      kind,
      name: presetFor(kind).name,
      baseURL: (baseURL ?? (presetFor(kind).baseURL || undefined))?.replace(/\/$/, ''),
      apiKey,
      apiKeyEnv,
      region,
      project,
      location,
      resourceName,
      apiVersion,
    };
  }
  private importProfile(source: Profile) {
    if (this.db.prepare('SELECT id FROM models WHERE id=?').get(source.id)) return;
    const profile = { ...source };
    const key = apiKeyFor(profile);
    if (key) {
      profile.apiKey = key;
      delete profile.apiKeyEnv;
    }
    const input = this.connectionFrom(profile);
    const signature = (p: Omit<StoredProvider, 'id'>) =>
      JSON.stringify([
        p.kind,
        p.baseURL?.replace(/\/$/, ''),
        p.apiKey,
        p.apiKeyEnv,
        p.region,
        p.project,
        p.location,
        p.resourceName,
        p.apiVersion,
      ]);
    let provider = this.allProviders().find((p) => signature(p) === signature(input));
    if (!provider) {
      provider = { ...input, id: randomUUID() };
      this.putProvider(provider);
    }
    const {
      id,
      name,
      model,
      reasoning,
      reasoningOffSupported,
      output,
      providerOptions,
      additionalInstructions,
      generation,
      requestBody,
    } = profile;
    const stored = StoredModelSchema.parse({
      id,
      providerId: provider.id,
      name,
      model,
      reasoning,
      reasoningOffSupported,
      output,
      providerOptions,
      additionalInstructions,
      generation,
      requestBody,
      api: profile.provider === 'openrouter-decisions' ? 'decisions' : 'default',
    });
    this.compile(provider, stored);
    this.putModel(stored);
  }
  async importLegacy(file = 'connections.local.json') {
    if (this.getSetting('legacy_imported')) return;
    const profiles = await loadProfiles(file);
    this.transaction(() => {
      if (!this.getSetting('legacy_imported')) {
        for (const profile of profiles) this.importProfile(profile);
        this.setSetting('legacy_imported', '1');
      }
    });
  }
  // Legacy profile API remains a compatibility layer over shared provider records.
  draft(raw: unknown, id?: string): Profile {
    const { clearApiKey, ...input } = ConnectionInputSchema.parse(raw);
    const previous = id ? this.get(id) : undefined;
    const profile = ProfileSchema.parse({
      ...input,
      id: id ?? randomUUID(),
      apiKey: clearApiKey ? undefined : (input.apiKey ?? previous?.apiKey),
      apiKeyEnv: clearApiKey || input.apiKey ? undefined : previous?.apiKeyEnv,
    });
    validateProfiles([profile]);
    return profile;
  }
  save(raw: unknown, id?: string) {
    const profile = this.draft(raw, id);
    this.transaction(() => {
      if (!id) this.importProfile(profile);
      else {
        const previous = this.model(id);
        const provider = { ...this.connectionFrom(profile), id: previous.providerId };
        for (const sibling of this.models(previous.providerId).filter((m) => m.id !== id))
          this.compile(provider, sibling);
        this.putProvider(provider);
        const {
          name,
          model,
          reasoning,
          reasoningOffSupported,
          output,
          providerOptions,
          additionalInstructions,
          generation,
          requestBody,
        } = profile;
        this.saveModel(
          previous.providerId,
          {
            name,
            model,
            reasoning,
            reasoningOffSupported,
            output,
            providerOptions,
            additionalInstructions,
            generation,
            requestBody,
            api: profile.provider === 'openrouter-decisions' ? 'decisions' : 'default',
          },
          id,
        );
      }
    });
    return editableProfile(this.get(profile.id));
  }
  duplicate(id: string) {
    const original = this.model(id);
    const { id: _id, providerId, ...input } = original;
    const copy = this.saveModel(providerId, {
      ...input,
      name: `${input.name.slice(0, 113)} (copy)`,
    });
    return editableProfile(this.get(copy.id));
  }
}
