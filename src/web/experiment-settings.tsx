import React, { useEffect, useState } from 'react';
import {
  ATTACK_PROMPTS,
  DEFAULT_PROMPTS,
  ExperimentSchema,
  type Experiment,
  type Prompts,
} from '../core/experiment.js';
import { api } from './api.js';
import { ModelSettings } from './settings.js';
import { RequestPreview } from './request-preview.js';
import { ProtocolSettings } from './protocol-settings.js';

type Translate = (en: string, ko: string) => string;
export function Settings({
  t,
  onChanged,
  readOnly = false,
}: {
  t: Translate;
  onChanged: () => Promise<void>;
  readOnly?: boolean;
}) {
  const [tab, setTab] = useState('models');
  const [visited, setVisited] = useState(new Set(['models']));
  const [protocol, setProtocol] = useState<'decisions' | 'llm'>('decisions');
  const [providerRevision, setProviderRevision] = useState(0);
  const [protocolRevision, setProtocolRevision] = useState(0);
  const tabs = [
    ['models', t('Providers & models', '공급자 및 모델')],
    ['prompts', t('Prompts & requests', '프롬프트 및 요청')],
    ['decisions', 'Decisions'],
    ['llm', 'LLM'],
  ];
  const show = (id: string) => {
    setTab(id);
    setVisited((previous) => new Set([...previous, id]));
    if (id === 'decisions' || id === 'llm') setProtocol(id);
  };
  return (
    <>
      <div
        className="provider-tabs settings-tabs"
        role="tablist"
        aria-label={t('Settings sections', '설정 항목')}
        onKeyDown={(e) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const index = tabs.findIndex(([id]) => id === tab);
          const next =
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? tabs.length - 1
                : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          const id = tabs[next][0];
          show(id);
          document.getElementById(`settings-tab-${id}`)?.focus();
        }}
      >
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`settings-tab-${id}`}
            aria-controls={`settings-panel-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => show(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="settings-panel-models"
        aria-labelledby="settings-tab-models"
        hidden={tab !== 'models'}
      >
        <ModelSettings
          t={t}
          readOnly={readOnly}
          revision={providerRevision}
          onChanged={async () => {
            setProtocolRevision((v) => v + 1);
            await onChanged();
          }}
        />
      </div>
      <div
        role="tabpanel"
        id="settings-panel-prompts"
        aria-labelledby="settings-tab-prompts"
        hidden={tab !== 'prompts'}
      >
        {visited.has('prompts') && <ExperimentSettings t={t} readOnly={readOnly} />}
      </div>
      <div
        role="tabpanel"
        id={`settings-panel-${protocol}`}
        aria-labelledby={`settings-tab-${protocol}`}
        hidden={tab !== 'decisions' && tab !== 'llm'}
      >
        {(visited.has('decisions') || visited.has('llm')) && (
          <ProtocolSettings
            t={t}
            type={protocol}
            revision={protocolRevision}
            readOnly={readOnly}

            onOpenProviders={() => show('models')}
            onChanged={async () => {
              setProviderRevision((v) => v + 1);
              await onChanged();
            }}
          />
        )}
      </div>
    </>
  );
}

function ExperimentSettings({ t, readOnly = false }: { t: Translate; readOnly?: boolean }) {
  const [form, setForm] = useState<Experiment | null>(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api<Experiment>('/settings/experiment')
      .then((value) => {
        if (!cancelled) {
          setForm(value);
          setSaved(JSON.stringify(value));
        }
      })
      .catch(() => {
        if (!cancelled) setError(t('Could not load settings.', '설정을 불러오지 못했습니다.'));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!form)
    return <p role={error ? 'alert' : 'status'}>{error || t('Loading…', '불러오는 중…')}</p>;
  const update = (key: keyof Prompts, value: string | string[]) => {
    setNotice('');
    setForm({ ...form, prompts: { ...form.prompts, [key]: value } });
  };
  const field = (key: Exclude<keyof Prompts, 'strategy'>, en: string, ko: string, rows = 4) => (
    <label key={key}>
      {t(en, ko)}
      <textarea
        aria-label={t(en, ko)}
        spellCheck={false}
        rows={rows}
        maxLength={16000}
        value={form.prompts[key]}
        onChange={(e) => update(key, e.target.value)}
      />
    </label>
  );
  const dirty = JSON.stringify(form) !== saved;
  return (
    <section className="content-section experiment-settings">
      <h2>{t('Prompts & requests', '프롬프트 및 요청')}</h2>
      <p className="hint">
        {t(
          'Shared by all models. Model-specific instructions are appended in model options. Saving applies to the next match or benchmark; a running batch keeps its original settings.',
          '모든 모델이 사용하는 공통 설정입니다. 모델 옵션에서 추가 지침을 붙일 수 있습니다. 저장한 설정은 다음 경기·벤치마크부터 적용되며 진행 중인 배치는 기존 설정을 유지합니다.',
        )}
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (readOnly) return;
          setBusy(true);
          setError('');
          setNotice('');
          try {
            const value = await api<Experiment>(
              '/settings/experiment',
              ExperimentSchema.parse(form),
              'PUT',
            );
            setForm(value);
            setSaved(JSON.stringify(value));
            setNotice(t('Saved for the next match.', '다음 경기부터 적용하도록 저장했습니다.'));
          } catch {
            setError(
              t(
                'Could not save. Check field lengths and numeric ranges.',
                '저장하지 못했습니다. 입력 길이와 숫자 범위를 확인하세요.',
              ),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy || readOnly}>
          <div className="form-actions">
            <button
              type="button"
              onClick={() => {
                setForm({ ...form, prompts: structuredClone(ATTACK_PROMPTS) });
                setNotice('');
              }}
            >
              {t('Triple / Tetris attack preset', '트리플·테트리스 공격 프리셋')}
            </button>
            <button
              type="button"
              onClick={() => {
                setForm({ ...form, prompts: structuredClone(DEFAULT_PROMPTS) });
                setNotice('');
              }}
            >
              {t('Reset prompts', '기본 프롬프트 복원')}
            </button>
          </div>
          <div className="prompt-fields">
            {field('instruction', 'Common instructions', '공통 지침', 5)}
            <label>
              {t('Strategy priorities — one per line', '전략 우선순위 — 한 줄에 하나씩')}
              <textarea
                aria-label={t(
                  'Strategy priorities — one per line',
                  '전략 우선순위 — 한 줄에 하나씩',
                )}
                rows={10}
                spellCheck={false}
                value={form.prompts.strategy.join('\n')}
                onChange={(e) => update('strategy', e.target.value.split('\n'))}
              />
            </label>
          </div>
          <details className="prompt-details">
            <summary>
              {t('Goals, rule descriptions & state legend', '목표·규칙 설명·상태 해설 편집')}
            </summary>
            <p className="hint">
              {t(
                'These are descriptions sent to the model. Editing them does not change game mechanics. The board, legal options and required choice response are generated by the engine.',
                '모델에 보내는 설명입니다. 문구를 수정해도 실제 게임 규칙은 바뀌지 않습니다. 보드·합법적인 선택지·선택 응답 형식은 엔진이 생성합니다.',
              )}
            </p>
            <div className="prompt-fields">
              {field('duelGoal', 'Duel goal', '대전 목표', 2)}
              {field('soloGoal', 'Solo goal', '단독 목표', 2)}
              {field('realtimeRules', 'Realtime rules description', '실시간 규칙 설명')}
              {field('decisionRules', 'Decision rules description', '판단 평가 규칙 설명')}
              {field('realtimeAttack', 'Realtime attack description', '실시간 공격 설명')}
              {field('decisionAttack', 'Decision attack description', '판단 평가 공격 설명')}
              {field('legend', 'State legend', '상태 해설', 8)}
            </div>
          </details>
          <div className="connection-fields execution-fields">
            <label>
              {t('Request timeout (ms)', '요청 제한 시간 (ms)')}
              <input
                type="number"
                min={100}
                max={120000}
                step={100}
                required
                value={form.timeoutMs}
                onChange={(e) => {
                  setForm({ ...form, timeoutMs: Number(e.target.value) });
                  setNotice('');
                }}
              />
            </label>
            <label>
              {t('Attempts per decision', '판단당 최대 시도 횟수')}
              <input
                type="number"
                min={1}
                max={5}
                required
                value={form.attempts}
                onChange={(e) => {
                  setForm({ ...form, attempts: Number(e.target.value) });
                  setNotice('');
                }}
              />
            </label>
          </div>
          <p className="hint">
            {t(
              'Attempts includes the initial call and applies to decision evaluation. Realtime play keeps gravity running while retrying. Explicit run API values take precedence over these defaults.',
              '시도 횟수는 최초 호출을 포함하며 판단 평가 모드에 적용됩니다. 실시간 모드에서는 재시도 중에도 중력이 작동합니다. 경기 API에 직접 지정한 값이 이 기본값보다 우선합니다.',
            )}
          </p>
          <div className="form-actions">
            <button type="submit">{t('Save prompts & requests', '프롬프트 및 요청 저장')}</button>
            <span className="hint">
              {dirty ? t('Unsaved changes', '저장하지 않은 변경 사항') : t('Saved', '저장됨')}
            </span>
          </div>
        </fieldset>
      </form>
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
      <RequestPreview
        t={t}
        input={() => (readOnly ? {} : { experiment: form })}
        revision={JSON.stringify(form)}
      />
    </section>
  );
}
