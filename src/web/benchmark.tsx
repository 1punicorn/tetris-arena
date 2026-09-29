import React from 'react';
import type { Snapshot } from '../core/runner.js';
import type { BenchmarkState } from '../core/run-config.js';
import { ModelPicker } from './model-picker.js';

export type BenchmarkDraft = {
  models: string[];
  seeds: string;
  maxTurns: number | null;
};
export function Benchmark({
  t,
  models,
  draft,
  onChange,
  benchmark,
  progress,
  snapshot,
  active,
  pending,
  connected,
  demoMode = false,
  onStart,
  onStop,
  onWatch,
}: {
  t: (en: string, ko: string) => string;
  models: React.ComponentProps<typeof ModelPicker>['options'];
  draft: BenchmarkDraft;
  onChange: (draft: BenchmarkDraft) => void;
  benchmark: BenchmarkState | null;
  progress: { total: number; completed: number; active: boolean };
  snapshot: Snapshot | null;
  active: boolean;
  pending: boolean;
  connected: boolean;
  demoMode?: boolean;
  onStart: () => void;
  onStop: () => void;
  onWatch: () => void;
}) {
  const seeds = draft.seeds
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const total = draft.models.length * (draft.models.length - 1) * seeds.length;
  const valid =
    draft.models.length >= 2 &&
    draft.models.length <= 12 &&
    draft.models.every((id) => models.some((m) => m.id === id && m.available)) &&
    seeds.length > 0 &&
    seeds.length <= 50 &&
    seeds.every((seed) => seed.length <= 100) &&
    (draft.maxTurns === null ||
      (Number.isInteger(draft.maxTurns) && draft.maxTurns >= 1 && draft.maxTurns <= 2000));
  const current = benchmark?.currentRunId === snapshot?.id ? snapshot : null;
  const name = (id: string) => models.find((m) => m.id === id)?.name ?? id;
  const status =
    benchmark?.status === 'running'
      ? snapshot?.status === 'paused'
        ? t('Paused', '일시 정지됨')
        : t('Running', '실행 중')
      : benchmark?.status === 'completed'
        ? t('Completed', '완료')
        : benchmark?.status === 'cancelled'
          ? t('Stopped', '중단됨')
          : t('Failed', '실패');
  return (
    <div className="benchmark-page">
      {benchmark && (
        <section
          className="benchmark-progress"
          aria-label={t('Benchmark progress', '벤치마크 진행 상황')}
        >
          <div className="section-title">
            <h2>{t('Batch progress', '배치 진행 상황')}</h2>
            <span className="benchmark-status" role="status">
              {status}
            </span>
          </div>
          <div className="benchmark-count">
            <strong>
              {progress.completed} / {progress.total}
            </strong>
            <span>{t('matches completed', '경기 완료')}</span>
          </div>
          <progress
            value={progress.completed}
            max={Math.max(1, progress.total)}
            aria-label={t('Completed matches', '완료 경기 수')}
          />
          <p className="hint">
            {benchmark.config.models.map(name).join(' · ')}
            <br />
            {benchmark.config.run.mode === 'decision'
              ? t('Decision evaluation', '판단 평가')
              : t('Real-time match', '실시간 대전')}
            {' · '}
            {benchmark.config.seeds.length} {t('seeds', '개 시드')}
            {' · '}
            {t('Swapped sides', '자리 교대')}
          </p>
          {progress.active && current && (
            <div className="benchmark-current">
              <span className="field-label">
                {t('Current match', '현재 대진')} ·{' '}
                {Math.min(progress.completed + 1, progress.total)} / {progress.total}
              </span>
              <strong>
                {name(current.config.players[0])} <span>vs</span> {name(current.config.players[1])}
              </strong>
              <small>
                {t('Seed', '시드')} {current.config.seed} · {t('Turn', '턴')} {current.turn}
              </small>
            </div>
          )}
          <div className="form-actions">
            {progress.active && (
              <>
                <button type="button" onClick={onWatch}>
                  {t('Watch current match', '현재 경기 보기')} <span aria-hidden="true">→</span>
                </button>
                <button type="button" disabled={pending || !connected} onClick={onStop}>
                  {t('Stop benchmark', '벤치마크 중단')}
                </button>
              </>
            )}
            <a className="page-link" href="#results">
              {t('View results', '결과 보기')} →
            </a>
          </div>
          {progress.active && (
            <p className="hint">
              {t(
                'Runs continue on the server when you leave this page. Stopping ends the current match and cancels the remaining schedule.',
                '이 화면을 떠나도 서버에서 계속 실행됩니다. 중단하면 현재 경기를 끝내고 남은 일정을 취소합니다.',
              )}
            </p>
          )}
        </section>
      )}
      <section className="benchmark-setup" aria-label={t('Benchmark settings', '벤치마크 설정')}>
        <h2>{t('Run settings', '실행 조건')}</h2>
        <p className="hint">
          {t(
            'Every model pairing plays each seed twice, swapping P1 and P2. These settings are separate from the arena.',
            '모든 모델 조합이 각 시드에서 P1·P2 자리를 바꿔 두 번씩 대전합니다. 대전 탭과 별도로 설정합니다.',
          )}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !active && !pending && connected) onStart();
          }}
        >
          <ModelPicker
            label={t('Benchmark models', '벤치마크 모델')}
            t={t}
            options={models.filter((m) => m.available)}
            value={draft.models}
            onChange={(selection) => onChange({ ...draft, models: selection })}
            multiple
            disabled={active || pending || demoMode}
            description={
              demoMode
                ? t(
                    'Models cannot be changed in demo mode.',
                    '데모 모드에서는 모델을 변경할 수 없습니다.',
                  )
                : undefined
            }
          />
          {draft.models.length > 0 && (
            <ul
              className="benchmark-selection"
              aria-label={t('Selected benchmark models', '선택한 벤치마크 모델')}
            >
              {draft.models.map((id) => {
                const model = models.find((item) => item.id === id);
                const displayName = model?.name ?? id;
                return (
                  <li key={id}>
                    <div>
                      <strong>{displayName}</strong>
                      <small>
                        {model && <span>{model.providerName ?? model.provider} · </span>}
                        <span className="benchmark-model-id">{model?.model ?? id}</span>
                        {!model?.available && <> · {t('Unavailable', '사용 불가')}</>}
                      </small>
                    </div>
                    {!demoMode && (
                      <button
                        type="button"
                        className="benchmark-remove"
                        aria-label={t(
                          `Remove ${displayName} from benchmark`,
                          `벤치마크에서 ${displayName} 제외`,
                        )}
                        title={t('Remove from this benchmark', '이번 벤치마크에서 제외')}
                        disabled={active || pending}
                        onClick={(e) => {
                          const row = e.currentTarget.closest('li');
                          const next = row?.nextElementSibling ?? row?.previousElementSibling;
                          const target =
                            next?.querySelector('button') ??
                            e.currentTarget
                              .closest('form')
                              ?.querySelector<HTMLButtonElement>('.model-select-trigger');
                          target?.focus();
                          onChange({
                            ...draft,
                            models: draft.models.filter((value) => value !== id),
                          });
                        }}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="benchmark-fields">
            <label>
              {t('Seeds (comma separated)', '시드 (쉼표로 구분)')}
              <input
                aria-label={t('Benchmark seeds', '벤치마크 시드')}
                value={draft.seeds}
                disabled={active || pending}
                maxLength={5049}
                onChange={(e) => onChange({ ...draft, seeds: e.target.value })}
              />
            </label>
            <label>
              {t('Turn limit per match', '경기당 최대 턴')}
              <input
                aria-label={t('Benchmark run limit', '벤치마크 경기 제한')}
                type="number"
                min={1}
                max={2000}
                value={draft.maxTurns ?? ''}
                placeholder={t('Unlimited', '무제한')}
                disabled={active || pending}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    maxTurns: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
          <p className="hint">
            {t(
              'Turn-based evaluation waits for both models before resolving each turn. Response times are recorded separately.',
              '턴제로 진행하며 두 모델의 판단을 모아 한 턴을 처리합니다. 응답 시간은 별도로 기록합니다.',
            )}
          </p>
          <div className="benchmark-launch">
            <div aria-live="polite">
              <strong>
                {total.toLocaleString()} {t('matches', '경기')}
              </strong>
              <small>
                {draft.models.length} {t('models', '개 모델')} × {seeds.length}{' '}
                {t('seeds', '개 시드')} · {t('all pairs, swapped sides', '모든 조합·자리 교대')}
              </small>
            </div>
            <button
              type="submit"
              className="primary"
              disabled={!valid || active || pending || !connected}
            >
              {t('Run benchmark', '벤치마크 실행')}
            </button>
          </div>
        </form>
        {!active && draft.models.length < 2 && (
          <p className="hint">
            {t(
              'Select at least two available models.',
              '사용 가능한 모델을 두 개 이상 선택하세요.',
            )}{' '}
            <a className="page-link" href="#settings">
              {t('Open settings', '설정 열기')} →
            </a>
          </p>
        )}
        {!active && (!seeds.length || seeds.length > 50 || seeds.some((s) => s.length > 100)) && (
          <p className="error">
            {t(
              'Enter 1–50 seeds, each at most 100 characters.',
              '시드를 1~50개 입력하세요. 각 시드는 최대 100자입니다.',
            )}
          </p>
        )}
        {active && !progress.active && (
          <p className="hint">
            {t(
              'A match is running in the arena. Finish it before starting a benchmark.',
              '대전이 진행 중입니다. 해당 경기가 끝나면 벤치마크를 시작할 수 있습니다.',
            )}{' '}
            <a className="page-link" href="#arena">
              {t('Open arena', '대전 보기')} →
            </a>
          </p>
        )}
      </section>
    </div>
  );
}
