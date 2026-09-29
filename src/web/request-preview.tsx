import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
type Translate = (en: string, ko: string) => string;

export function RequestPreview({
  t,
  modelId,
  input,
  revision,
}: {
  t: Translate;
  modelId?: string;
  input: () => Record<string, unknown>;
  revision: string;
}) {
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState(modelId ?? '');
  const [mode, setMode] = useState('decision');
  const [duel, setDuel] = useState(true);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    if (modelId) return;
    let cancelled = false;
    void api<{ id: string; name: string; provider: string }[]>('/connections')
      .then((items) => {
        if (cancelled) return;
        const available = items.filter((m) => m.provider !== 'baseline');
        setModels(available);
        setSelected(available[0]?.id ?? '');
      })
      .catch(() => {
        if (!cancelled) setError(t('Could not load models.', '모델을 불러오지 못했습니다.'));
      });
    return () => {
      cancelled = true;
    };
  }, [modelId]);
  useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setPreview('');
    setError('');
    return () => {
      pending.current?.abort();
    };
  }, [revision, selected, mode, duel]);
  return (
    <div className="request-preview">
      <h3>{t('Request preview', '요청 미리보기')}</h3>
      <p className="hint">
        {t(
          'Uses a sample board and the current editor values. No API call or charge. The board and legal options change each turn.',
          '예시 보드와 현재 편집 내용을 사용합니다. API 호출이나 요금이 발생하지 않습니다. 실제 보드와 합법적인 선택지는 턴마다 달라집니다.',
        )}
      </p>
      <div className="preview-controls">
        {!modelId && (
          <label>
            {t('Preview model', '미리보기 모델')}
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {!models.length && (
                <option value="">{t('Register a model first', '모델을 먼저 등록하세요')}</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {t('Preview mode', '미리보기 모드')}
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="decision">{t('Decision evaluation', '판단 평가')}</option>
            <option value="realtime">{t('Realtime', '실시간')}</option>
          </select>
        </label>
        <label>
          {t('Preview game', '미리보기 경기')}
          <select
            value={duel ? 'duel' : 'solo'}
            onChange={(e) => setDuel(e.target.value === 'duel')}
          >
            <option value="duel">{t('Duel', '대전')}</option>
            <option value="solo">{t('Solo', '단독')}</option>
          </select>
        </label>
        <button
          type="button"
          disabled={busy || !selected}
          onClick={async () => {
            const controller = new AbortController();
            pending.current = controller;
            setBusy(true);
            setError('');
            setPreview('');
            try {
              const result = await api(
                '/settings/preview',
                { ...input(), modelId: selected, mode, duel },
                undefined,
                controller.signal,
              );
              if (!controller.signal.aborted) setPreview(JSON.stringify(result, null, 2));
            } catch {
              if (!controller.signal.aborted)
                setError(
                  t(
                    'Preview failed. Check JSON, parameter names and model settings.',
                    '미리보기에 실패했습니다. JSON, 파라미터 이름과 모델 설정을 확인하세요.',
                  ),
                );
            } finally {
              if (!controller.signal.aborted) setBusy(false);
            }
          }}
        >
          {busy ? t('Preparing…', '준비 중…') : t('Preview request', '요청 미리보기')}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <pre className="request-json" aria-label={t('Request JSON', '요청 JSON')}>
          {preview}
        </pre>
      )}
    </div>
  );
}
