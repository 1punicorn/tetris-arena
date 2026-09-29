import React, { useEffect, useState } from 'react';
import type { EditableProvider, StoredModel } from '../providers/registry.js';
import { api } from './api.js';
import { ModelOptions } from './settings.js';
import { ModelPicker } from './model-picker.js';

type ModelType = 'decisions' | 'llm';
type Translate = (en: string, ko: string) => string;

export function ProtocolSettings({
  t,
  type,
  revision,
  onChanged,
  onOpenProviders,
  readOnly = false,
}: {
  t: Translate;
  type: ModelType;
  revision: number;
  onChanged: () => Promise<void>;
  onOpenProviders: () => void;
  readOnly?: boolean;
}) {
  const [providers, setProviders] = useState<EditableProvider[]>([]);
  const [models, setModels] = useState<StoredModel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const [selection, setSelection] = useState({ decisions: '', llm: '' });
  const [opened, setOpened] = useState<Set<string>>(new Set());
  useEffect(() => {
    const request = new AbortController();
    setError('');
    void (async () => {
      const providers = await api<EditableProvider[]>(
        '/settings/providers',
        undefined,
        undefined,
        request.signal,
      );
      const groups = await Promise.all(
        providers.map((provider) =>
          api<StoredModel[]>(
            `/settings/providers/${provider.id}/models`,
            undefined,
            undefined,
            request.signal,
          ),
        ),
      );
      if (request.signal.aborted) return;
      setProviders(providers);
      setModels(groups.flat());
      setLoaded(true);
    })().catch(() => {
      if (!request.signal.aborted) setError('load_failed');
    });
    return () => request.abort();
  }, [revision, retry]);
  const providerName = (model: StoredModel) =>
    providers.find((p) => p.id === model.providerId)?.name ?? model.providerId;
  const typed = models.filter((m) => (m.api === 'decisions' ? 'decisions' : 'llm') === type);
  const selectedId = typed.find((m) => m.id === selection[type])?.id ?? typed[0]?.id ?? '';
  useEffect(() => {
    setOpened((previous) => {
      if (!selectedId || previous.has(selectedId)) return previous;
      return new Set([...previous, selectedId]);
    });
  }, [selectedId]);
  return (
    <section className="protocol-settings">
      <h2>
        {type === 'decisions'
          ? t('Decisions model options', 'Decisions 모델 옵션')
          : t('LLM model options', 'LLM 모델 옵션')}
      </h2>
      <p className="hint">
        {readOnly
          ? t(
              'Choose a model to inspect its saved options. Demo settings are read-only.',
              '모델을 선택해 저장된 옵션을 확인하세요. 데모 설정은 읽기 전용입니다.',
            )
          : t(
              'Choose a model to edit its options. Changes apply only to that model, starting with the next match or benchmark.',
              '모델을 선택해 해당 모델의 옵션을 편집하세요. 변경 사항은 해당 모델에만 적용되며 다음 경기·벤치마크부터 사용합니다.',
            )}
      </p>
      {error && (
        <p className="error" role="alert">
          {t('Could not load saved models.', '저장된 모델을 불러오지 못했습니다.')}{' '}
          <button type="button" onClick={() => setRetry((v) => v + 1)}>
            {t('Retry', '다시 시도')}
          </button>
        </p>
      )}
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
      )}
      {!loaded && !error && <p role="status">{t('Loading…', '불러오는 중…')}</p>}
      {loaded && !typed.length && (
        <div className="protocol-empty">
          <p className="hint">
            {type === 'decisions'
              ? t('No Decisions models registered.', '등록된 Decisions 모델이 없습니다.')
              : t('No LLM models registered.', '등록된 LLM 모델이 없습니다.')}
          </p>
          <button type="button" onClick={onOpenProviders}>
            {t('Register models', '모델 등록하기')}
          </button>
        </div>
      )}
      {typed.length > 0 && (
        <div className="protocol-picker">
          <div>
            <span className="field-label">{t('Model to configure', '설정할 모델')}</span>
            <ModelPicker
              key={type}
              label={t('Model to configure', '설정할 모델')}
              t={t}
              options={typed.map((model) => ({
                id: model.id,
                name: model.name,
                model: model.model,
                provider: model.providerId,
                providerName: providerName(model),
                available: true,
              }))}
              value={[selectedId]}
              onChange={([id]) => setSelection((previous) => ({ ...previous, [type]: id }))}
            />
          </div>
          <span className="hint">
            {typed.length} {t('models', '개 모델')}
          </span>
        </div>
      )}
      {models
        .filter((m) => opened.has(m.id) || m.id === selectedId)
        .map((model) => (
          <section
            className="protocol-model"
            key={model.id}
            hidden={model.id !== selectedId}
            aria-labelledby={`model-options-${model.id}`}
          >
            <div className="protocol-model-heading">
              <h3 id={`model-options-${model.id}`}>{model.name}</h3>
              <p>
                {providerName(model)} · <span className="benchmark-model-id">{model.model}</span>
                {!model.enabled && <> · {t('Not enabled', '사용 안 함')}</>}
              </p>
            </div>
            <ModelOptions
              model={model}
              t={t}
              readOnly={readOnly}
              onSaved={async (updated, removedId) => {
                setModels((previous) =>
                  updated
                    ? previous.map((m) => (m.id === updated.id ? updated : m))
                    : previous.filter((m) => m.id !== removedId),
                );
                setNotice(
                  updated ? '' : t(`Removed ${model.name}.`, `${model.name}을 삭제했습니다.`),
                );
                await onChanged();
              }}
            />
          </section>
        ))}
    </section>
  );
}
