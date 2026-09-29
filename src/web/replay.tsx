import React, { useEffect, useState } from 'react';
import type { RunEvent, Snapshot } from '../core/runner.js';
import { PlayerGame } from './game-view.js';
import { matchTime } from './time.js';

type RecordedModel = { id: string; model: string; provider: string; reasoning?: string | null };
type Recording = {
  id: string;
  frames: Snapshot[];
  connections: RecordedModel[];
  createdAt?: string;
};

export function Replay({
  active,
  runId,
  t,
}: {
  active: boolean;
  runId: string;
  t: (en: string, ko: string) => string;
}) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    setRecording(null);
    setFrame(0);
    setPlaying(false);
    setError(false);
    const root = `/api/results/${encodeURIComponent(runId)}`;
    void (async () => {
      const [events, metadata] = await Promise.all([
        fetch(`${root}/events.jsonl`, { signal: controller.signal }).then(async (response) => {
          if (!response.ok) throw new Error('replay_unavailable');
          return response.text();
        }),
        fetch(`${root}/metadata.json`, { signal: controller.signal })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
      ]);
      const frames = events
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as RunEvent)
        .filter((event) => event.type === 'state')
        .map((event) => event.snapshot);
      if (!frames.length) throw new Error('empty_replay');
      if (!controller.signal.aborted)
        setRecording({
          id: runId,
          frames,
          connections: Array.isArray(metadata?.connections) ? metadata.connections : [],
          createdAt: Number.isFinite(Date.parse(metadata?.createdAt))
            ? metadata.createdAt
            : undefined,
        });
    })().catch(() => {
      if (!controller.signal.aborted) setError(true);
    });
    return () => controller.abort();
  }, [runId, retry]);

  const frames = recording?.frames ?? [];
  useEffect(() => {
    if (!active || frame >= frames.length - 1) setPlaying(false);
  }, [active, frame, frames.length]);
  useEffect(() => {
    if (!active || !playing) return;
    const timer = setInterval(() => setFrame((n) => Math.min(n + 1, frames.length - 1)), 100);
    return () => clearInterval(timer);
  }, [active, playing, frames.length]);

  if (!active) return null;
  if (!runId)
    return (
      <section className="replay-empty">
        <h2>{t('Choose a match to replay', '다시 볼 경기를 선택하세요')}</h2>
        <p className="hint">
          {t(
            'Open a replay from Results to review its boards and decisions.',
            '결과 탭에서 리플레이를 열면 보드와 판단 과정을 확인할 수 있습니다.',
          )}
        </p>
        <a className="page-link" href="#results">
          {t('Browse results', '경기 기록 보기')} →
        </a>
      </section>
    );
  if (error)
    return (
      <section className="replay-empty">
        <p role="alert">
          {t('This replay could not be loaded.', '리플레이를 불러오지 못했습니다.')}
        </p>
        <div className="form-actions">
          <button onClick={() => setRetry((n) => n + 1)}>{t('Retry', '다시 시도')}</button>
          <a className="page-link" href="#results">
            {t('Browse results', '경기 기록 보기')} →
          </a>
        </div>
      </section>
    );
  if (!recording || recording.id !== runId)
    return <p role="status">{t('Loading replay…', '리플레이를 불러오는 중…')}</p>;

  const shown = frames[frame];
  const last = frames[frames.length - 1];
  return (
    <div className="replay-page">
      <section className="replay-overview" aria-label={t('Recorded match', '저장된 경기')}>
        <div>
          <h2>
            {shown.config.mode === 'decision'
              ? t('Decision evaluation', '판단 평가')
              : t('Real-time match', '실시간 대전')}
            {' · '}
            {t('Seed', '시드')} {shown.config.seed}
          </h2>
          <p className="hint">
            {last.winner === null ? last.reason : `P${last.winner + 1} ${t('wins', '승리')}`}
            {' · '}
            {t('Match', '경기')} {recording.id.slice(0, 8)}
            {recording.createdAt && (
              <>
                {' '}
                ·{' '}
                <time dateTime={recording.createdAt} title={recording.createdAt}>
                  {matchTime(recording.createdAt, t('en-US', 'ko-KR'))}
                </time>
              </>
            )}
          </p>
        </div>
        <a className="page-link" href="#results">
          {t('Choose another match', '다른 경기 선택')} →
        </a>
      </section>
      <div className="match-strip">
        <span className="status">
          {playing
            ? t('Playing replay', '리플레이 재생 중')
            : frame === frames.length - 1
              ? t('Replay complete', '리플레이 종료')
              : t('Replay paused', '리플레이 일시 정지')}
        </span>
        <span>
          {t('Turn', '턴')} {shown.turn} <b>·</b> {(shown.elapsedMs / 1000).toFixed(1)} /{' '}
          {(last.elapsedMs / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="replay" aria-label={t('Replay controls', '리플레이 조작')}>
        <button
          onClick={() => {
            if (frame === frames.length - 1) setFrame(0);
            setPlaying(!playing);
          }}
          disabled={frames.length < 2}
        >
          {playing ? t('Pause replay', '일시 정지') : t('Play replay', '재생')}
        </button>
        <input
          aria-label={t('Replay position', '리플레이 위치')}
          type="range"
          min="0"
          max={frames.length - 1}
          value={frame}
          onChange={(e) => {
            setPlaying(false);
            setFrame(Number(e.target.value));
          }}
        />
        <span>
          {frame + 1} / {frames.length}
        </span>
      </div>
      <section className="arena replay-boards" aria-label={t('Recorded boards', '저장된 보드')}>
        {[0, 1].map((p) => {
          const id = shown.config.players[p];
          const saved = recording.connections.find((model) => model.id === id);
          const model =
            shown.stats[p].actualModel ??
            last.stats[p].actualModel ??
            saved?.model ??
            shown.config.modelOverrides[id] ??
            id;
          return (
            <article className={`player player-${p}`} key={p}>
              <div className="replay-player-heading">
                <span className="player-number">P{p + 1}</span>
                <h3>{model}</h3>
              </div>
              <div className="model-info">
                {shown.stats[p].provider ?? last.stats[p].provider ?? saved?.provider ?? 'local'}
                {saved?.reasoning && (
                  <span>
                    {t('reasoning', '추론')} · {saved.reasoning}
                  </span>
                )}
              </div>
              <PlayerGame snapshot={shown} player={p} t={t} />
            </article>
          );
        })}
      </section>
    </div>
  );
}
