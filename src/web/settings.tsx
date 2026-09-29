import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  providerPresets,
  presetFor,
  type Catalog,
  type CatalogModel,
  type ProviderKind,
} from '../providers/presets.js';
import {
  ModelInputSchema,
  type ProviderInput,
  type EditableProvider,
  type StoredModel,
  type ModelInput,
} from '../providers/registry.js';
import { api } from './api.js';
import { RequestPreview } from './request-preview.js';

type Translate = (en: string, ko: string) => string;
const DEFAULT_MODEL_OPTIONS = ModelInputSchema.omit({
  name: true,
  model: true,
  enabled: true,
  api: true,
}).parse({});
const fresh = (): ProviderInput => ({
  name: 'OpenAI',
  kind: 'openai',
  baseURL: presetFor('openai').baseURL,
  clearApiKey: false,
});
const keyOf = (m: { api: string; id: string }) => `${m.api}:${m.id}`;
function providerForm(p: EditableProvider): ProviderInput {
  const { id: _id, hasApiKey: _key, modelCount: _count, enabledCount: _enabled, ...values } = p;
  return { ...values, clearApiKey: false };
}
function errorText(e: unknown, t: Translate): string {
  const code = (e as Error).message;
  const messages: Record<string, string> = {
    invalid_configuration: t(
      'Check the required fields and model options.',
      '필수 입력 항목과 모델 옵션을 확인하세요.',
    ),
    missing_base_url: t('Enter an API base URL.', 'API 주소를 입력하세요.'),
    remote_endpoint_requires_https: t(
      'Remote API addresses must use HTTPS.',
      '원격 API 주소는 HTTPS를 사용해야 합니다.',
    ),
    invalid_endpoint: t(
      'Use an HTTP(S) URL without credentials or query parameters.',
      '인증 정보나 쿼리가 없는 HTTP(S) 주소를 입력하세요.',
    ),
    unsupported_model_protocol: t(
      'The Decisions protocol requires OpenRouter.',
      'Decisions 프로토콜은 OpenRouter에서만 사용할 수 있습니다.',
    ),
    reasoning_off_not_confirmed: t(
      'Use provider default or confirm support for disabling reasoning.',
      '공급자 기본값을 선택하거나 추론 끄기 지원을 확인하세요.',
    ),
    model_limit: t(
      'A provider can store up to 500 models. Remove unused saved models first.',
      '공급자당 최대 500개 모델을 저장할 수 있습니다. 사용하지 않는 저장 모델을 먼저 삭제하세요.',
    ),
    timeout: t(
      'The provider timed out. You can still add model IDs manually.',
      '공급자 응답 시간이 초과되었습니다. 모델 ID를 직접 추가할 수 있습니다.',
    ),
    invalid_options: t('Model options must be a JSON object.', '모델 옵션은 JSON 객체여야 합니다.'),
  };
  return (
    messages[code] ??
    (code.startsWith('http_')
      ? t(
          `Provider returned HTTP ${code.slice(5)}. Check the API key and address.`,
          `공급자가 HTTP ${code.slice(5)} 오류를 반환했습니다. API 키와 주소를 확인하세요.`,
        )
      : t(
          'Request failed. Check the connection and try again.',
          '요청에 실패했습니다. 연결을 확인하고 다시 시도하세요.',
        ))
  );
}

export function ModelSettings({
  t,
  onChanged,
  revision = 0,
  readOnly = false,
}: {
  t: Translate;
  onChanged: () => Promise<void>;
  revision?: number;
  readOnly?: boolean;
}) {
  const [providers, setProviders] = useState<EditableProvider[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderInput>(fresh);
  const [pane, setPane] = useState<'models' | 'connection'>('connection');
  const [saved, setSaved] = useState<StoredModel[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [manual, setManual] = useState<CatalogModel[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [visible, setVisible] = useState(100);
  const [manualId, setManualId] = useState('');
  const [manualApi, setManualApi] = useState<'default' | 'decisions'>('default');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const discovery = useRef<AbortController | null>(null);
  const selected = providers.find((p) => p.id === selectedId);
  const applied = new Set(saved.filter((m) => m.enabled).map((m) => `${m.api}:${m.model}`));
  const dirty = selection.size !== applied.size || [...selection].some((k) => !applied.has(k));
  const rows = useMemo(() => {
    const merged = new Map<string, CatalogModel>();
    for (const m of catalog?.models ?? []) merged.set(keyOf(m), m);
    for (const m of manual) merged.set(keyOf(m), m);
    for (const m of saved) {
      const key = `${m.api}:${m.model}`;
      merged.set(key, {
        ...merged.get(key),
        id: m.model,
        name: m.name,
        api: m.api,
        supported: true,
      });
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [catalog, manual, saved]);
  const filtered = rows.filter(
    (m) =>
      `${m.name} ${m.id}`.toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'selected' ? selection.has(keyOf(m)) : !selection.has(keyOf(m)))),
  );
  const reload = async () => setProviders(await api<EditableProvider[]>('/settings/providers'));
  useEffect(() => {
    void reload().catch((e) => setError(errorText(e, t)));
    return () => {
      controller.current?.abort();
      discovery.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!revision) return;
    const request = new AbortController();
    void (async () => {
      const providers = await api<EditableProvider[]>(
        '/settings/providers',
        undefined,
        undefined,
        request.signal,
      );
      const models = selectedId
        ? await api<StoredModel[]>(
            `/settings/providers/${selectedId}/models`,
            undefined,
            undefined,
            request.signal,
          )
        : null;
      if (request.signal.aborted) return;
      setProviders(providers);
      if (models) {
        const enabled = new Set(models.filter((m) => m.enabled).map((m) => `${m.api}:${m.model}`));
        setSelection((previous) => {
          const next = new Set(previous);
          for (const key of applied) if (!enabled.has(key)) next.delete(key);
          for (const key of enabled) if (!applied.has(key)) next.add(key);
          return next;
        });
        setSaved(models);
      }
    })().catch((e) => {
      if (!request.signal.aborted) setError(errorText(e, t));
    });
    return () => request.abort();
  }, [revision, selectedId]);
  useEffect(() => {
    setVisible(100);
  }, [query, filter]);
  const perform = async (fn: () => Promise<void>) => {
    if (readOnly) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  const fetchCatalog = async (p: EditableProvider) => {
    if (readOnly) return;
    discovery.current?.abort();
    const request = new AbortController();
    discovery.current = request;
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const result = await api<Catalog>(
        '/settings/catalog',
        { provider: providerForm(p), providerId: p.id },
        'POST',
        request.signal,
      );
      if (!request.signal.aborted) setCatalog(result);
    } catch (e) {
      if (!request.signal.aborted) setCatalogError(errorText(e, t));
    } finally {
      if (!request.signal.aborted) setCatalogLoading(false);
    }
  };
  const open = async (p: EditableProvider | null, discard = false) => {
    if (
      !discard &&
      dirty &&
      !window.confirm(
        t('Discard unapplied model selections?', '아직 적용하지 않은 모델 선택을 취소할까요?'),
      )
    )
      return;
    controller.current?.abort();
    discovery.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setSelectedId(p?.id ?? null);
    setForm(p ? providerForm(p) : fresh());
    setPane(p ? 'models' : 'connection');
    setSaved([]);
    setSelection(new Set());
    setManual([]);
    setCatalog(null);
    setQuery('');
    setFilter('all');
    setVisible(100);
    setEditing(null);
    setManualId('');
    setManualApi('default');
    setConfirmDelete(false);
    setError('');
    setNotice('');
    setCatalogError('');
    setCatalogLoading(false);
    setLoading(!!p);
    if (!p) return;
    try {
      const models = await api<StoredModel[]>(
        `/settings/providers/${p.id}/models`,
        undefined,
        undefined,
        request.signal,
      );
      if (request.signal.aborted) return;
      setSaved(models);
      setSelection(new Set(models.filter((m) => m.enabled).map((m) => `${m.api}:${m.model}`)));
      void fetchCatalog(p);
    } catch (e) {
      if (!request.signal.aborted) setError(errorText(e, t));
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  };
  useEffect(() => {
    if (readOnly && !selectedId && providers[0]) void open(providers[0], true);
  }, [readOnly, selectedId, providers]);
  const change = <K extends keyof ProviderInput>(key: K, value: ProviderInput[K]) =>
    setForm((p) => ({ ...p, [key]: value }));
  const saveConnection = () =>
    perform(async () => {
      const p = await api<EditableProvider>(
        selectedId ? `/settings/providers/${selectedId}` : '/settings/providers',
        {
          ...form,
          name: form.name.trim(),
          apiKey: form.apiKey?.trim() || undefined,
          baseURL: form.baseURL?.trim() || undefined,
        },
        selectedId ? 'PUT' : 'POST',
      );
      await reload();
      await onChanged();
      // Preserve unapplied model choices when editing an existing shared key or URL.
      if (selectedId) {
        setForm(providerForm(p));
        setPane('models');
        setCatalog(null);
        void fetchCatalog(p);
      } else await open(p, true);
      setNotice(
        t(
          'Provider saved. Choose the models to use below.',
          '공급자를 저장했습니다. 아래에서 사용할 모델을 선택하세요.',
        ),
      );
    });
  const toggle = (key: string) =>
    setSelection((previous) => {
      const next = new Set(previous);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const apply = () =>
    perform(async () => {
      const models = await api<StoredModel[]>(
        `/settings/providers/${selectedId}/models`,
        {
          models: rows
            .filter((m) => selection.has(keyOf(m)))
            .map((m) => ({ model: m.id, name: m.name.slice(0, 120), api: m.api })),
        },
        'PUT',
      );
      setSaved(models);
      setManual([]);
      await reload();
      await onChanged();
      setNotice(
        t(
          'Models applied. They are now available in the arena and benchmark.',
          '모델을 적용했습니다. 대전과 벤치마크에서 선택할 수 있습니다.',
        ),
      );
    });
  const updateModel = async (model: StoredModel | null, removedId?: string) => {
    const models = await api<StoredModel[]>(`/settings/providers/${selectedId}/models`);
    setSaved(models);
    setEditing(null);
    if (removedId) {
      const removed = saved.find((m) => m.id === removedId);
      if (removed)
        setSelection((p) => {
          const next = new Set(p);
          next.delete(`${removed.api}:${removed.model}`);
          return next;
        });
    }
    await reload();
    await onChanged();
    setNotice(
      model
        ? t('Model options saved.', '모델 옵션을 저장했습니다.')
        : t('Saved model removed.', '저장 모델을 삭제했습니다.'),
    );
  };
  return (
    <section className="model-settings" aria-label={t('Providers and models', '공급자와 모델')}>
      <div className="connection-layout">
        <aside className="connection-list">
          <h2>{t('Providers', '공급자')}</h2>
          <button
            className="add-connection"
            disabled={busy || readOnly}
            onClick={() => void open(null)}
          >
            {t('Add provider', '공급자 추가')} +
          </button>
          {!providers.length && (
            <p className="hint">
              {t(
                'Connect once. Choose as many models as you need.',
                '한 번 연결하고 필요한 모델을 골라 사용하세요.',
              )}
            </p>
          )}
          {providers.map((p) => (
            <button
              key={p.id}
              className={selectedId === p.id ? 'selected' : ''}
              aria-pressed={selectedId === p.id}
              disabled={busy}
              onClick={() => void open(p)}
            >
              <strong>{p.name}</strong>
              <small>{presetFor(p.kind).name}</small>
              <span>
                {p.enabledCount} {t('enabled', '사용 중')}
              </span>
            </button>
          ))}
        </aside>
        <div className="provider-workspace">
          <div className="provider-heading">
            <h2>{selected?.name ?? t('New provider', '새 공급자')}</h2>
            {selected && (
              <div
                className="provider-tabs"
                role="group"
                aria-label={t('Provider view', '공급자 화면')}
              >
                <button aria-pressed={pane === 'models'} onClick={() => setPane('models')}>
                  {t('Models', '모델')}
                </button>
                <button aria-pressed={pane === 'connection'} onClick={() => setPane('connection')}>
                  {t('Connection', '연결')}
                </button>
              </div>
            )}
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="success" role="status">
              {notice}
            </p>
          )}
          {pane === 'connection' ? (
            <form
              className="connection-editor"
              onSubmit={(e) => {
                e.preventDefault();
                void saveConnection();
              }}
            >
              <p className="hint">
                {t(
                  'One API key for all models from this provider.',
                  '이 공급자의 모든 모델이 하나의 API 키를 공유합니다.',
                )}
              </p>
              <fieldset disabled={busy || readOnly}>
                <div className="connection-fields">
                  <label>
                    {t('Provider', '공급자')}
                    <select
                      aria-label={t('Provider', '공급자')}
                      value={form.kind}
                      disabled={!!selectedId}
                      onChange={(e) => {
                        const preset = presetFor(e.target.value as ProviderKind);
                        setForm({
                          ...fresh(),
                          kind: preset.kind,
                          name: preset.name,
                          baseURL: preset.baseURL || undefined,
                        });
                      }}
                    >
                      {providerPresets.map((p) => (
                        <option value={p.kind} key={p.kind}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('Display name', '표시 이름')}
                    <input
                      required
                      maxLength={120}
                      value={form.name}
                      onChange={(e) => change('name', e.target.value)}
                    />
                  </label>
                  <label className="full-field">
                    {t('API key', 'API 키')}
                    <input
                      type="password"
                      autoComplete="new-password"
                      maxLength={8192}
                      value={form.apiKey ?? ''}
                      placeholder={
                        selected?.hasApiKey
                          ? readOnly
                            ? t('Saved · hidden', '저장됨 · 비공개')
                            : t('Saved — leave blank to keep it', '저장됨 — 비워 두면 기존 키 유지')
                          : t(
                              'Local servers may not require a key',
                              '로컬 서버는 키가 필요하지 않을 수 있습니다',
                            )
                      }
                      onChange={(e) =>
                        setForm((p) => ({ ...p, apiKey: e.target.value, clearApiKey: false }))
                      }
                    />
                  </label>
                  {selected?.hasApiKey && (
                    <label className="inline-check full-field">
                      <input
                        type="checkbox"
                        checked={form.clearApiKey}
                        onChange={(e) =>
                          setForm((p) => ({
                            ...p,
                            clearApiKey: e.target.checked,
                            apiKey: undefined,
                          }))
                        }
                      />
                      {t('Remove saved key', '저장된 키 삭제')}
                    </label>
                  )}
                  <label className="full-field">
                    {t('API base URL', 'API 주소')}
                    <input
                      aria-label={t('API base URL', 'API 주소')}
                      aria-describedby="provider-url-hint"
                      type="url"
                      value={form.baseURL ?? ''}
                      placeholder="https://…/v1"
                      onChange={(e) => change('baseURL', e.target.value)}
                    />
                    <small id="provider-url-hint">
                      {t(
                        'Defaults are prefilled. Localhost refers to the machine running this app’s server.',
                        '기본 주소가 미리 입력됩니다. localhost는 이 앱의 서버가 실행 중인 컴퓨터를 가리킵니다.',
                      )}
                    </small>
                  </label>
                  {['azure', 'bedrock', 'vertex'].includes(form.kind) && (
                    <>
                      {(form.kind === 'azure'
                        ? ['resourceName', 'apiVersion']
                        : form.kind === 'bedrock'
                          ? ['region']
                          : ['project', 'location']
                      ).map((field) => (
                        <label key={field}>
                          {field}
                          <input
                            value={(form[field as keyof ProviderInput] as string) ?? ''}
                            onChange={(e) =>
                              change(field as keyof ProviderInput, e.target.value || undefined)
                            }
                          />
                        </label>
                      ))}
                      <p className="hint full-field">
                        {t(
                          'Add deployment/model IDs manually. Cloud identity credentials may also be required on the server.',
                          '배포·모델 ID를 직접 추가하세요. 서버에 클라우드 인증 정보가 필요할 수 있습니다.',
                        )}
                      </p>
                    </>
                  )}
                </div>
                <div className="form-actions">
                  <button className="primary" type="submit">
                    {busy
                      ? t('Saving…', '저장 중…')
                      : selectedId
                        ? t('Save provider', '공급자 저장')
                        : t('Save & browse models', '저장하고 모델 찾기')}
                  </button>
                  {selectedId && (
                    <button type="button" className="danger" onClick={() => setConfirmDelete(true)}>
                      {t('Delete provider', '공급자 삭제')}
                    </button>
                  )}
                </div>
              </fieldset>
              {confirmDelete && (
                <div className="delete-confirm">
                  <p>
                    {t(
                      'Delete this provider and all its saved models? Past results are kept.',
                      '공급자와 연결된 모델을 모두 삭제할까요? 이전 경기 결과는 유지됩니다.',
                    )}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await api(`/settings/providers/${selectedId}`, undefined, 'DELETE');
                        await reload();
                        await onChanged();
                        await open(null, true);
                        setNotice(t('Provider deleted.', '공급자를 삭제했습니다.'));
                      })
                    }
                  >
                    {t('Confirm deletion', '삭제 확인')}
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)}>
                    {t('Cancel', '취소')}
                  </button>
                </div>
              )}
            </form>
          ) : (
            <>
              <p className="hint">
                {t(
                  'Select models, then apply. Only enabled models appear in match selectors.',
                  '모델을 선택한 뒤 적용하세요. 사용 중인 모델만 대전 선택 목록에 표시됩니다.',
                )}
              </p>
              <div className="catalog-toolbar">
                <input
                  type="search"
                  aria-label={t('Search provider models', '공급자 모델 검색')}
                  placeholder={t('Search by model name or ID…', '모델 이름 또는 ID 검색…')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select
                  aria-label={t('Filter models', '모델 필터')}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">{t('All models', '전체 모델')}</option>
                  <option value="selected">{t('Selected', '선택됨')}</option>
                  <option value="unselected">{t('Not selected', '선택 안 됨')}</option>
                </select>
                <button
                  disabled={readOnly || catalogLoading || loading || busy}
                  onClick={() => selected && void fetchCatalog(selected)}
                >
                  {catalogLoading ? t('Fetching…', '조회 중…') : t('Refresh', '새로고침')}
                </button>
              </div>
              {catalogError && (
                <p className="hint catalog-error" role="alert">
                  {catalogError}{' '}
                  {t(
                    'Saved models remain available. You can also enter an ID below.',
                    '저장된 모델은 계속 사용할 수 있으며 아래에서 ID를 직접 추가할 수 있습니다.',
                  )}
                </p>
              )}
              {catalog && !catalog.supported && (
                <p className="hint">
                  {t(
                    'This provider uses manually registered model or deployment IDs.',
                    '이 공급자는 모델 또는 배포 ID를 직접 등록해서 사용합니다.',
                  )}
                </p>
              )}
              {catalog?.truncated && (
                <p className="hint">
                  {t(
                    'The catalog is limited to 10,000 models. Add any missing IDs manually.',
                    '목록은 최대 10,000개까지 표시됩니다. 누락된 ID는 직접 추가하세요.',
                  )}
                </p>
              )}
              <div className="catalog-summary">
                <span>
                  {filtered.length.toLocaleString()} {t('models', '개 모델')} · {selection.size}{' '}
                  {t('selected', '개 선택')}
                </span>
                <div>
                  <button
                    className="text-button"
                    disabled={readOnly || busy || loading}
                    onClick={() =>
                      setSelection(
                        (p) => new Set([...p, ...filtered.filter((m) => m.supported).map(keyOf)]),
                      )
                    }
                  >
                    {t('Select results', '검색 결과 선택')}
                  </button>
                  <button
                    className="text-button"
                    disabled={readOnly || busy || loading}
                    onClick={() =>
                      setSelection(
                        (p) => new Set([...p].filter((k) => !filtered.some((m) => keyOf(m) === k))),
                      )
                    }
                  >
                    {t('Clear results', '검색 결과 해제')}
                  </button>
                </div>
              </div>
              <div className="catalog-apply">
                <span>
                  {dirty
                    ? t('Unapplied changes', '아직 적용하지 않은 변경 사항')
                    : t(`${applied.size} models enabled`, `${applied.size}개 모델 사용 중`)}
                </span>
                <button
                  className="primary"
                  disabled={readOnly || busy || loading || !dirty || selection.size > 500}
                  onClick={() => void apply()}
                >
                  {busy ? t('Applying…', '적용 중…') : t('Apply models', '모델 적용')}
                </button>
              </div>
              {selection.size > 500 && (
                <p className="error">
                  {t(
                    'Select up to 500 models per provider.',
                    '공급자당 모델을 최대 500개까지 선택하세요.',
                  )}
                </p>
              )}
              <div className="catalog-list" aria-busy={loading || catalogLoading}>
                {loading && (
                  <p className="empty">
                    {t('Loading saved models…', '저장된 모델을 불러오는 중…')}
                  </p>
                )}
                {!loading && !filtered.length && (
                  <p className="empty">
                    {catalogLoading
                      ? t('Fetching provider catalog…', '공급자 모델 목록을 가져오는 중…')
                      : query
                        ? t(
                            'No matching models. Try another name or add an ID below.',
                            '일치하는 모델이 없습니다. 다른 이름을 검색하거나 아래에서 ID를 추가하세요.',
                          )
                        : t(
                            'No models yet. Fetch a catalog or add a model ID below.',
                            '아직 모델이 없습니다. 목록을 조회하거나 아래에서 모델 ID를 추가하세요.',
                          )}
                  </p>
                )}
                {filtered.slice(0, visible).map((m) => {
                  const key = keyOf(m),
                    records = saved.filter((s) => s.model === m.id && s.api === m.api);
                  return (
                    <React.Fragment key={key}>
                      <div className="catalog-row">
                        <label className="catalog-choice">
                          <input
                            type="checkbox"
                            checked={selection.has(key)}
                            disabled={readOnly || busy || !m.supported}
                            onChange={() => toggle(key)}
                            aria-label={m.name}
                          />
                          <span>
                            <strong>{m.name}</strong>
                            <small>{m.id}</small>
                          </span>
                        </label>
                        <div className="catalog-meta">
                          {!m.supported ? (
                            <span>{t('Not text generation', '텍스트 생성 미지원')}</span>
                          ) : (
                            <>
                              {m.api === 'decisions' && <span>Decisions</span>}
                              {!!m.contextLength && (
                                <span title={t('Context window', '컨텍스트 길이')}>
                                  {Intl.NumberFormat('en', { notation: 'compact' }).format(
                                    m.contextLength,
                                  )}{' '}
                                  ctx
                                </span>
                              )}
                            </>
                          )}
                          {records.map((record) => (
                            <button
                              className="text-button"
                              key={record.id}
                              aria-label={`${t('Options for', '모델 옵션')} ${record.name}`}
                              disabled={busy || dirty}
                              title={
                                dirty
                                  ? t('Apply model selections first', '모델 선택을 먼저 적용하세요')
                                  : undefined
                              }
                              onClick={() => setEditing(editing === record.id ? null : record.id)}
                            >
                              {t('Options', '옵션')}
                            </button>
                          ))}
                        </div>
                      </div>
                      {records
                        .filter((record) => editing === record.id)
                        .map((record) => (
                          <ModelOptions
                            key={record.id}
                            model={record}
                            t={t}
                            onSaved={updateModel}
                            readOnly={readOnly}
                          />
                        ))}
                    </React.Fragment>
                  );
                })}
              </div>
              {filtered.length > visible && (
                <button className="catalog-more" onClick={() => setVisible((v) => v + 100)}>
                  {t('Show more', '더 보기')} ({Math.min(visible, filtered.length)} /{' '}
                  {filtered.length})
                </button>
              )}
              <form
                className="manual-model"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (readOnly) return;
                  const id = manualId.trim();
                  if (!id) return;
                  const row: CatalogModel = { id, name: id, api: manualApi, supported: true };
                  setManual((p) => [...p.filter((m) => keyOf(m) !== keyOf(row)), row]);
                  setSelection((p) => new Set([...p, keyOf(row)]));
                  setQuery(id);
                  setFilter('all');
                  setManualId('');
                }}
              >
                <label>
                  {t('Add a model ID manually', '모델 ID 직접 추가')}
                  <input
                    required
                    maxLength={256}
                    disabled={readOnly}
                    value={manualId}
                    placeholder={t('Model ID or deployment name', '모델 ID 또는 배포 이름')}
                    onChange={(e) => setManualId(e.target.value)}
                  />
                </label>
                {selected?.kind === 'openrouter' && (
                  <label>
                    {t('API protocol', 'API 프로토콜')}
                    <select
                      disabled={readOnly}
                      value={manualApi}
                      onChange={(e) => setManualApi(e.target.value as typeof manualApi)}
                    >
                      <option value="default">Chat completions</option>
                      <option value="decisions">Decisions</option>
                    </select>
                  </label>
                )}
                <button disabled={readOnly || busy || loading} type="submit">
                  {t('Add', '추가')}
                </button>
              </form>
              <p className="hint catalog-footnote">
                {t(
                  'Catalog availability does not guarantee model access or compatibility. Model options include an optional test decision.',
                  '목록에 있어도 계정 권한이나 모델 기능에 따라 실행이 제한될 수 있습니다. 모델 옵션에서 테스트할 수 있습니다.',
                )}
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export function ModelOptions({
  model,
  t,
  onSaved,
  readOnly = false,
}: {
  model: StoredModel;
  readOnly?: boolean;
  t: Translate;
  onSaved: (model: StoredModel | null, removedId?: string) => Promise<void>;
}) {
  const { id, providerId: _providerId, ...initial } = model;
  const [form, setForm] = useState<ModelInput>(initial);
  const [options, setOptions] = useState(JSON.stringify(initial.providerOptions, null, 2));
  const [requestBody, setRequestBody] = useState(JSON.stringify(initial.requestBody, null, 2));
  const savedVersion = JSON.stringify(model);
  useEffect(() => {
    setForm(initial);
    setOptions(JSON.stringify(initial.providerOptions, null, 2));
    setRequestBody(JSON.stringify(initial.requestBody, null, 2));
  }, [savedVersion]);
  const draft = () => ({
    ...form,
    providerOptions: JSON.parse(options),
    requestBody: JSON.parse(requestBody),
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [remove, setRemove] = useState(false);
  const perform = async (fn: () => Promise<void>) => {
    if (readOnly) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="model-options"
      onSubmit={(e) => {
        e.preventDefault();
        if (readOnly) return;
        void perform(async () => {
          await onSaved(
            await api<StoredModel>(`/settings/registered-models/${id}`, draft(), 'PUT'),
          );
          setNotice(t('Options saved.', '옵션을 저장했습니다.'));
        });
      }}
    >
      <fieldset disabled={busy || readOnly}>
        <p className="hint">
          {form.api === 'decisions'
            ? t(
                'API type: Decisions · uses state and choice questions. LLM generation, reasoning and output-format settings do not apply.',
                'API 유형: Decisions · 상태와 선택 질문을 전송합니다. LLM 생성·추론·출력 형식 설정은 적용되지 않습니다.',
              )
            : t(
                'API type: LLM · uses messages and a JSON choice response.',
                'API 유형: LLM · 메시지를 보내고 JSON 선택 응답을 받습니다.',
              )}
        </p>
        <p className="hint model-defaults">
          <strong>{t('App defaults', '앱 기본값')}</strong>
          {' · '}
          {form.api === 'decisions'
            ? t(
                'Uses the common instructions and native choice response. Additional instructions and extra request options are empty.',
                '공통 지침과 전용 선택 응답 형식을 사용합니다. 모델별 추가 지침과 추가 요청 옵션은 비어 있습니다.',
              )
            : t(
                `Structured output · ${DEFAULT_MODEL_OPTIONS.generation.maxOutputTokens?.toLocaleString()} output tokens · provider-default reasoning. Empty sampling fields are omitted from requests so the API uses its defaults.`,
                `구조화 출력 · 최대 출력 ${DEFAULT_MODEL_OPTIONS.generation.maxOutputTokens?.toLocaleString()}토큰 · 추론은 공급자 기본값. 비어 있는 샘플링 옵션은 요청에서 생략해 API 기본값을 사용합니다.`,
              )}
        </p>
        <div className="connection-fields">
          <label>
            {t('Model display name', '모델 표시 이름')}
            <input
              required
              maxLength={120}
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            />
          </label>
          {form.api !== 'decisions' && (
            <>
              <label>
                {t('Reasoning', '추론')}
                <select
                  value={form.reasoning}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, reasoning: e.target.value as ModelInput['reasoning'] }))
                  }
                >
                  <option value="provider-default">{t('Provider default', '공급자 기본값')}</option>
                  <option value="on">{t('On', '켜기')}</option>
                  <option value="off">{t('Off', '끄기')}</option>
                </select>
              </label>
              {form.reasoning === 'on' && (
                <label>
                  {t('Reasoning effort', '추론 강도')}
                  <select
                    value={form.generation.reasoningEffort}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        generation: {
                          ...form.generation,
                          reasoningEffort: e.target
                            .value as ModelInput['generation']['reasoningEffort'],
                        },
                      })
                    }
                  >
                    {['minimal', 'low', 'medium', 'high', 'xhigh'].map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {form.reasoning === 'off' && (
                <label className="inline-check full-field">
                  <input
                    type="checkbox"
                    checked={form.reasoningOffSupported}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, reasoningOffSupported: e.target.checked }))
                    }
                  />
                  {t('This model supports disabling reasoning', '이 모델은 추론 끄기를 지원합니다')}
                </label>
              )}
              <label>
                {t('Output format', '출력 형식')}
                <select
                  value={form.output}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, output: e.target.value as ModelInput['output'] }))
                  }
                >
                  <option value="schema">Structured output</option>
                  <option value="json-text">JSON text</option>
                </select>
              </label>
              {(
                [
                  ['maxOutputTokens', 'Max output tokens', '최대 출력 토큰', 1, 1000000, 1],
                  ['temperature', 'Temperature', 'Temperature', 0, 2, 0.01],
                  ['topP', 'Top P', 'Top P', 0, 1, 0.01],
                  ['topK', 'Top K', 'Top K', 1, undefined, 1],
                  ['presencePenalty', 'Presence penalty', 'Presence penalty', -2, 2, 0.01],
                  ['frequencyPenalty', 'Frequency penalty', 'Frequency penalty', -2, 2, 0.01],
                  ['seed', 'API seed', 'API 시드', -2147483648, 2147483647, 1],
                ] as const
              ).map(([key, en, ko, min, max, step]) => (
                <label key={key}>
                  {t(en, ko)}
                  <input
                    aria-label={t(en, ko)}
                    type="number"
                    min={min}
                    max={max}
                    step={step}
                    placeholder={t('Provider default', '공급자 기본값')}
                    value={form.generation[key] ?? ''}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        generation: {
                          ...form.generation,
                          [key]:
                            e.target.value === ''
                              ? key === 'maxOutputTokens'
                                ? null
                                : undefined
                              : Number(e.target.value),
                        },
                      })
                    }
                  />
                  {key === 'maxOutputTokens' && (
                    <small>
                      {t('Clear to use the API default.', '비우면 API 기본값을 사용합니다.')}
                    </small>
                  )}
                </label>
              ))}
              <label className="full-field">
                {t('Stop sequences — one per line', '중지 문자열 — 한 줄에 하나씩')}
                <textarea
                  rows={2}
                  value={form.generation.stopSequences?.join('\n') ?? ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      generation: {
                        ...form.generation,
                        stopSequences: e.target.value
                          ? e.target.value.split('\n').filter(Boolean)
                          : undefined,
                      },
                    })
                  }
                />
              </label>
              <label className="full-field">
                {t('Provider options (JSON)', '공급자 옵션 (JSON)')}
                <textarea
                  rows={3}
                  spellCheck={false}
                  value={options}
                  onChange={(e) => setOptions(e.target.value)}
                />
              </label>
              <p className="hint full-field">
                {t(
                  'Empty numeric fields use provider defaults. Parameter support varies by endpoint and model; unsupported values may be ignored or rejected. Preview shows the serialized request. API seed is separate from the game seed.',
                  '숫자 칸을 비우면 공급자 기본값을 사용합니다. 파라미터 지원은 API와 모델마다 다르며 미지원 값은 무시되거나 오류가 날 수 있습니다. 미리보기에서 전송 내용을 확인하세요. API 시드와 게임 시드는 별개입니다.',
                )}
              </p>
            </>
          )}
          <label className="full-field">
            {t('Additional model instructions', '모델별 추가 지침')}
            <textarea
              rows={5}
              maxLength={16000}
              spellCheck={false}
              value={form.additionalInstructions}
              aria-label={t('Additional model instructions', '모델별 추가 지침')}
              onChange={(e) => setForm({ ...form, additionalInstructions: e.target.value })}
            />
            <small>
              {t(
                'Appended after common instructions. Can specify this model’s own strategy or exceptions.',
                '공통 지침 뒤에 추가됩니다. 이 모델만의 전략이나 예외를 명시할 수 있습니다.',
              )}
            </small>
          </label>
          <label className="full-field">
            {t('Extra request body (JSON)', '추가 요청 본문 (JSON)')}
            <textarea
              rows={5}
              spellCheck={false}
              value={requestBody}
              aria-label={t('Extra request body (JSON)', '추가 요청 본문 (JSON)')}
              onChange={(e) => setRequestBody(e.target.value)}
            />
            <small>
              {t(
                'Advanced: merged into the final API body, overriding matching parameter values. Model, messages/state, legal choices, streaming and response format are engine-managed. Use the exact parameter names for this API.',
                '고급: 최종 API 본문에 병합되며 같은 이름의 파라미터 값을 덮어씁니다. 모델·메시지/상태·합법적인 선택지·스트리밍·응답 형식은 엔진이 관리합니다. 해당 API의 정확한 파라미터 이름을 사용하세요.',
              )}
            </small>
          </label>
          {form.api === 'decisions' && (
            <p className="hint full-field">
              {t(
                'Decisions documents provider routing, session_id, trace and user. Temperature and token limits are not documented for this endpoint.',
                'Decisions 문서에는 provider 라우팅, session_id, trace, user가 제공됩니다. 이 API의 temperature·토큰 제한 지원은 명시되어 있지 않습니다.',
              )}{' '}
              <a
                href="https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request"
                target="_blank"
                rel="noreferrer"
              >
                {t('API reference', 'API 문서')} ↗
              </a>
            </p>
          )}
        </div>
        <div className="form-actions">
          <button type="submit">{t('Save options', '옵션 저장')}</button>
          <button
            type="button"
            onClick={() => {
              setForm({
                ...form,
                ...structuredClone(DEFAULT_MODEL_OPTIONS),
              });
              setOptions(JSON.stringify(DEFAULT_MODEL_OPTIONS.providerOptions, null, 2));
              setRequestBody(JSON.stringify(DEFAULT_MODEL_OPTIONS.requestBody, null, 2));
              setNotice(
                t(
                  'Defaults restored in the editor. Save to apply.',
                  '기본값을 불러왔습니다. 저장하면 적용됩니다.',
                ),
              );
            }}
          >
            {t('Reset model options', '모델 옵션 초기화')}
          </button>
          <button
            type="button"
            onClick={() =>
              void perform(async () => {
                const result = await api<{ latencyMs: number }>(
                  `/settings/registered-models/${id}/test`,
                  {},
                );
                setNotice(
                  t(`Test passed · ${result.latencyMs} ms`, `테스트 성공 · ${result.latencyMs} ms`),
                );
              })
            }
          >
            {t('Test saved model', '저장 모델 테스트')}
          </button>
          <button type="button" className="danger" onClick={() => setRemove(true)}>
            {t('Remove saved model', '저장 모델 삭제')}
          </button>
        </div>
      </fieldset>
      <RequestPreview
        t={t}
        modelId={id}
        input={() => (readOnly ? {} : { model: draft() })}
        revision={JSON.stringify([form, options, requestBody])}
      />
      <p className="hint">
        {t(
          'Testing sends one decision using saved options and may incur API charges.',
          '테스트는 저장된 옵션으로 한 번 판단을 요청하며 API 요금이 발생할 수 있습니다.',
        )}
      </p>
      {remove && (
        <div className="form-actions">
          <span>{t('Remove this saved model?', '저장 모델을 삭제할까요?')}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await api(`/settings/registered-models/${id}`, undefined, 'DELETE');
                await onSaved(null, id);
              })
            }
          >
            {t('Confirm removal', '삭제 확인')}
          </button>
          <button type="button" onClick={() => setRemove(false)}>
            {t('Cancel', '취소')}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
      )}
    </form>
  );
}
