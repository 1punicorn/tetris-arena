import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  emptyGame,
  visibleBoard,
  landingPiece,
  SHAPES,
  type Game,
  type Kind,
  type Action,
} from '../core/engine.js';
import type { Snapshot } from '../core/runner.js';
import { api } from './api.js';
import { Settings } from './experiment-settings.js';
import { ModelPicker } from './model-picker.js';
import { Benchmark, type BenchmarkDraft } from './benchmark.js';
import type { BenchmarkState } from '../core/run-config.js';
import type { DemoMode } from '../server/demo.js';
import './style.css';

type Connection = {
  id: string;
  name: string;
  model: string;
  provider: string;
  providerName?: string;
  providerId?: string;
  reasoning: string;
  available: boolean;
  output?: string;
};
type State = {
  snapshot: Snapshot | null;
  progress: { total: number; completed: number; active: boolean };
  benchmark: BenchmarkState | null;
  error: string | null;
  demo: DemoMode | null;
};
function Preview({ kind }: { kind: Kind | null }) {
  return (
    <span className="preview" aria-label={kind ?? 'empty'}>
      {Array.from({ length: 16 }, (_, i) => (
        <i
          key={i}
          className={kind && SHAPES[kind][Math.floor(i / 4)]?.[i % 4] ? `cell ${kind}` : 'cell'}
        />
      ))}
    </span>
  );
}
function Board({ game }: { game: Game }) {
  const board = visibleBoard(game),
    ghost = landingPiece(game);
  return (
    <div className="board" role="img" aria-label={`Tetris board, ${game.lines} lines cleared`}>
      {board.flatMap((row, y) =>
        row.map((cell, x) => {
          const projected = !cell && ghost?.shape[y - ghost.y]?.[x - ghost.x];
          return (
            <i key={y * 10 + x} className={`cell ${cell ?? ''} ${projected ? 'ghost' : ''}`} />
          );
        }),
      )}
    </div>
  );
}
type Page = 'arena' | 'benchmark' | 'results' | 'settings';
function currentPage(): Page {
  const hash = window.location.hash;
  return hash === '#settings'
    ? 'settings'
    : hash === '#results'
      ? 'results'
      : hash === '#benchmark'
        ? 'benchmark'
        : 'arena';
}
function App() {
  const [ko, setKo] = useState(false),
    t = useCallback((en: string, kr: string) => (ko ? kr : en), [ko]);
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#191b18' : '#ffffff');
    try {
      localStorage.setItem('tetris-theme', theme);
    } catch {
      // Theme switching still works when browser storage is unavailable.
    }
  }, [theme]);
  const themeAction =
    theme === 'light'
      ? t('Switch to dark mode', '다크 모드로 전환')
      : t('Switch to light mode', '라이트 모드로 전환');
  const [page, setPage] = useState<Page>(currentPage);
  const [connections, setConnections] = useState<Connection[]>([]),
    [players, setPlayers] = useState<[string, string]>(['', '']);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [mode, setMode] = useState<'realtime' | 'decision'>('realtime'),
    [seed, setSeed] = useState('1'),
    [limit, setLimit] = useState<number | null>(null),
    [turns, setTurns] = useState<number | null>(null);
  const [state, setState] = useState<State>({
      snapshot: null,
      progress: { total: 0, completed: 0, active: false },
      benchmark: null,
      error: null,
      demo: null,
    }),
    [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'reconnecting'>(
      'connecting',
    );
  const [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [results, setResults] = useState<Snapshot[]>([]);
  const [frames, setFrames] = useState<Snapshot[]>([]),
    [frame, setFrame] = useState(0),
    [replayPlaying, setReplayPlaying] = useState(false);
  const [benchDraft, setBenchDraft] = useState<BenchmarkDraft>({
    models: [],
    seeds: '1,2,3,4,5',
    maxTurns: null,
  });
  const active =
    state.progress.active ||
    (!!state.snapshot && ['playing', 'paused'].includes(state.snapshot.status));
  const shown = frames.length ? frames[frame] : state.snapshot;
  const liveConfig = active ? state.snapshot?.config : undefined;
  const demo = state.demo;
  const configuredPlayers = demo?.models ?? players;
  const arenaPlayers = liveConfig?.players ?? configuredPlayers;
  const arenaMode = liveConfig?.mode ?? mode;
  const registeredModels = connections.filter((c) => c.provider !== 'baseline');
  const canStart = configuredPlayers.every(
    (id, index) =>
      (index === 1 && id === 'none') ||
      (mode === 'realtime' && id === 'human') ||
      registeredModels.some((c) => c.id === id && c.available),
  );
  const runConfig = {
    mode,
    players: configuredPlayers,
    seed,
    maxSeconds: limit,
    maxTurns: turns,
    modelOverrides: {},
  };
  const refresh = () =>
    api<Snapshot[]>('/results')
      .then(setResults)
      .catch(() => {});
  const refreshConnections = async () => {
    const latest = await api<Connection[]>('/connections');
    setConnections(latest);
    setConnectionsLoaded(true);
    const ids = new Set(
      latest.filter((c) => c.provider !== 'baseline' && c.available).map((c) => c.id),
    );
    setBenchDraft((previous) => ({
      ...previous,
      models: previous.models.filter((id) => ids.has(id)),
    }));
  };
  const perform = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    const navigate = () => setPage(currentPage());
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
    if (page === 'results') void refresh();
    if (page !== 'arena') setReplayPlaying(false);
  }, [page]);
  useEffect(() => {
    void api<Connection[]>('/connections')
      .then((latest) => {
        setConnections(latest);
        setConnectionsLoaded(true);
        setBenchDraft((previous) => ({
          ...previous,
          models: previous.models.length
            ? previous.models
            : latest
                .filter((c) => c.provider !== 'baseline' && c.available)
                .slice(0, 2)
                .map((c) => c.id),
        }));
      })
      .catch((e) => setError(e.message));
    void refresh();
    const events = new EventSource('/api/events');
    events.addEventListener('state', (event) => {
      setState(JSON.parse(event.data));
      setConnectionStatus('connected');
    });
    events.onerror = () => setConnectionStatus('reconnecting');
    return () => events.close();
  }, []);
  useEffect(() => {
    const config = state.snapshot?.config;
    // Completed runs describe history; only restore a match that is still running.
    if (config && state.snapshot?.status !== 'finished' && !state.progress.active) {
      setPlayers(config.players);
      setMode(config.mode);
      setSeed(config.seed);
      setLimit(config.maxSeconds);
      setTurns(config.maxTurns);
    }
  }, [state.snapshot?.id]);
  const batchConfigKey =
    state.benchmark?.status === 'running' ? JSON.stringify(state.benchmark.config) : '';
  useEffect(() => {
    if (!batchConfigKey) return;
    const config = JSON.parse(batchConfigKey) as BenchmarkState['config'];
    setBenchDraft({
      models: config.models,
      seeds: config.seeds.join(','),
      maxTurns: config.run.maxTurns,
    });
  }, [batchConfigKey]);
  useEffect(() => {
    document.documentElement.lang = ko ? 'ko' : 'en';
  }, [ko]);
  useEffect(() => {
    if (active || !connectionsLoaded) return;
    const models = connections.filter((c) => c.provider !== 'baseline' && c.available);
    const ids = new Set(models.map((c) => c.id));
    setPlayers((previous) => {
      const first =
        ids.has(previous[0]) || (mode === 'realtime' && previous[0] === 'human')
          ? previous[0]
          : (models[0]?.id ?? '');
      const second =
        ids.has(previous[1]) ||
        previous[1] === 'none' ||
        (mode === 'realtime' && previous[1] === 'human' && first !== 'human')
          ? previous[1]
          : (models.find((c) => c.id !== first)?.id ?? 'none');
      return first === previous[0] && second === previous[1] ? previous : [first, second];
    });
  }, [connections, connectionsLoaded, active, mode, players.join(',')]);
  useEffect(() => {
    if (state.snapshot?.status === 'finished') void refresh();
  }, [state.snapshot?.id, state.snapshot?.status]);
  useEffect(() => {
    if (!replayPlaying) return;
    const timer = setInterval(
      () =>
        setFrame((n) => {
          if (n + 1 >= frames.length) {
            setReplayPlaying(false);
            return n;
          }
          return n + 1;
        }),
      100,
    );
    return () => clearInterval(timer);
  }, [replayPlaying, frames.length]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        page !== 'arena' ||
        (e.target as HTMLElement).closest('input,select,textarea,button') ||
        frames.length
      )
        return;
      const p = state.snapshot?.config.players.indexOf('human') ?? -1;
      if (p < 0) return;
      const actions: Record<string, Action> = {
        ArrowLeft: 'left',
        ArrowRight: 'right',
        ArrowDown: 'down',
        ArrowUp: 'clockwise',
        x: 'clockwise',
        z: 'counterclockwise',
        ' ': 'drop',
        c: 'hold',
        Shift: 'hold',
      };
      if (actions[e.key]) {
        e.preventDefault();
        void api('/action', { player: p, action: actions[e.key] }).catch(() => {});
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [state.snapshot?.config.players.join(','), frames.length, page]);
  const replay = async (id: string) => {
    const response = await fetch(`/api/results/${id}/events.jsonl`);
    if (!response.ok) throw new Error('replay_unavailable');
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    setFrames(events.filter((e) => e.type === 'state').map((e) => e.snapshot));
    setFrame(0);
    setReplayPlaying(false);
    window.location.hash = 'arena';
  };
  const summary =
    shown?.status === 'finished'
      ? shown.reason === 'top_out'
        ? shown.winner === null
          ? t('Draw', '무승부')
          : `P${shown.winner + 1} ${t('wins', '승리')}`
        : shown.reason
      : (shown?.status ?? t('Ready to play', '대전 준비'));
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#arena" aria-label="Tetris AI Bench">
          <svg className="brand-mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M1 5h6v6H1zm8 0h6v6H9zm8 0h6v6h-6zm-8 8h6v6H9z" />
          </svg>
          <span>
            Tetris <span className="brand-secondary">Bench</span>
          </span>
        </a>
        <nav className="main-nav" aria-label={t('Main navigation', '주 메뉴')}>
          <a href="#arena" aria-current={page === 'arena' ? 'page' : undefined}>
            {t('Arena', '대전')}
          </a>
          <a href="#benchmark" aria-current={page === 'benchmark' ? 'page' : undefined}>
            {t('Benchmark', '벤치마크')}
          </a>
          <a href="#results" aria-current={page === 'results' ? 'page' : undefined}>
            {t('Results', '결과')}
          </a>
          <a href="#settings" aria-current={page === 'settings' ? 'page' : undefined}>
            {t('Settings', '설정')}
          </a>
        </nav>
        <div className="header-actions">
          <button
            className="text-button theme-toggle"
            aria-label={themeAction}
            title={themeAction}
            onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {theme === 'light' ? (
                <path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z" />
              ) : (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
                </>
              )}
            </svg>
          </button>
          <button className="text-button" onClick={() => setKo(!ko)}>
            {ko ? 'English' : '한국어'}
          </button>
          <a
            className="github-link"
            href="https://github.com/1punicorn/tetris-arena"
            target="_blank"
            rel="noreferrer"
          >
            GitHub ↗
          </a>
        </div>
      </header>
      {connectionStatus === 'reconnecting' && (
        <p className="hint" role="status">
          {t('Reconnecting to the server…', '서버에 다시 연결하는 중…')}
        </p>
      )}
      <div className="page-heading">
        <div>
          <h1>
            {page === 'settings'
              ? t('Settings', '설정')
              : page === 'results'
                ? t('Results & replay', '결과 및 다시 보기')
                : page === 'benchmark'
                  ? t('Benchmark', '벤치마크')
                  : t('Arena', '대전')}
          </h1>
          <p>
            {page === 'settings'
              ? t(
                  'Configure providers, models and playing strategies.',
                  '벤치마크에 사용할 모델과 연결을 관리하세요.',
                )
              : page === 'results'
                ? t(
                    'Review completed matches, replay decisions and export results.',
                    '완료된 경기를 다시 보고 결과를 내보내세요.',
                  )
                : page === 'benchmark'
                  ? t(
                      'Compare models through repeated turn-based matches.',
                      '턴제 반복 대전으로 모델의 판단과 전략을 비교하세요.',
                    )
                  : t(
                      'Run matches and compare model decisions.',
                      '모델을 대전시키고 판단 결과를 비교하세요.',
                    )}
          </p>
        </div>
        {page === 'arena' && (
          <span className="protocol-note">
            {t('Assisted play · 26 choices', '판단 보조 · 26개 선택지')}
          </span>
        )}
      </div>
      {(error || state.error) && (
        <div role="alert" className="error">
          {error || state.error} <button onClick={() => setError('')}>×</button>
        </div>
      )}
      {page === 'settings' ? (
        <Settings
          t={t}
          onChanged={refreshConnections}
          demoModels={demo ? registeredModels : undefined}
        />
      ) : page === 'benchmark' ? (
        <Benchmark
          t={t}
          models={registeredModels}
          draft={demo ? { ...benchDraft, models: demo.models } : benchDraft}
          demoMode={!!demo}
          onChange={setBenchDraft}
          benchmark={state.benchmark}
          progress={state.progress}
          snapshot={state.snapshot}
          active={active}
          pending={pending}
          connected={connectionStatus === 'connected'}
          onStart={() =>
            void perform(async () => {
              setFrames([]);
              setReplayPlaying(false);
              await api('/bench', {
                models: demo?.models ?? benchDraft.models,
                seeds: benchDraft.seeds
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
                run: {
                  mode: 'decision',
                  maxTurns: benchDraft.maxTurns,
                },
              });
            })
          }
          onStop={() => void perform(async () => setState(await api<State>('/cancel', {})))}
          onWatch={() => {
            setFrames([]);
            setReplayPlaying(false);
            window.location.hash = 'arena';
          }}
        />
      ) : page === 'results' ? (
        <section className="content-section results-section">
          <div className="section-title">
            <h2>{t('Match history', '경기 기록')}</h2>
            <a href="/api/results.csv">{t('Export CSV', 'CSV 내려받기')} ↓</a>
          </div>
          {!results.length ? (
            <p className="hint">
              {t(
                'Completed runs appear here. No API calls are made during replay.',
                '완료된 경기 기록이 표시됩니다. 다시 보기에는 API를 호출하지 않습니다.',
              )}
            </p>
          ) : (
            <div className="results">
              {results.slice(0, 30).map((s) => (
                <div className="result" key={s.id}>
                  <div>
                    <strong>
                      {s.config.players
                        .map((id) => connections.find((c) => c.id === id)?.name ?? id)
                        .join(' / ')}
                    </strong>
                    <small>
                      {s.config.mode} · seed {s.config.seed} · {s.reason} · {s.id.slice(0, 8)}
                    </small>
                  </div>
                  <span>{s.winner === null ? '—' : `P${s.winner + 1} ${t('wins', '승리')}`}</span>
                  <button className="small" onClick={() => void perform(() => replay(s.id))}>
                    {t('Replay', '다시 보기')}
                  </button>
                  <a href={`/api/results/${s.id}/summary.json`} target="_blank" rel="noreferrer">
                    JSON ↗
                  </a>
                  <a href={`/api/results/${s.id}/metadata.json`} target="_blank" rel="noreferrer">
                    {t('Prompts & settings', '프롬프트 및 설정')} ↗
                  </a>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          <section className="setup" aria-label="Match settings">
            <div className="settings">
              <label>
                {t('Mode', '모드')}
                <select
                  aria-label="Mode"
                  value={arenaMode}
                  disabled={active}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                >
                  <option value="realtime">{t('Real-time match', '실시간 대전')}</option>
                  <option value="decision">{t('Decision evaluation', '판단 평가')}</option>
                </select>
              </label>
              <label>
                {t('Seed', '시드')}
                <input
                  aria-label="Seed"
                  value={liveConfig?.seed ?? seed}
                  maxLength={100}
                  disabled={active}
                  onChange={(e) => setSeed(e.target.value)}
                />
              </label>
              <label>
                {arenaMode === 'realtime'
                  ? t('Time limit (s)', '제한 시간 (초)')
                  : t('Turn limit', '최대 턴')}
                <input
                  aria-label="Run limit"
                  type="number"
                  min="1"
                  max={arenaMode === 'realtime' ? 600 : 2000}
                  disabled={active}
                  value={
                    (liveConfig
                      ? arenaMode === 'realtime'
                        ? liveConfig.maxSeconds
                        : liveConfig.maxTurns
                      : mode === 'realtime'
                        ? limit
                        : turns) ?? ''
                  }
                  placeholder={t('Unlimited', '무제한')}
                  onChange={(e) =>
                    (mode === 'realtime' ? setLimit : setTurns)(
                      e.target.value === '' ? null : Number(e.target.value),
                    )
                  }
                />
              </label>
              <button
                className="primary"
                disabled={active || pending || connectionStatus !== 'connected' || !canStart}
                onClick={() =>
                  void perform(async () => {
                    setFrames([]);
                    await api('/runs', runConfig);
                  })
                }
              >
                {t('Start match', '대전 시작')}
              </button>
              <button
                disabled={!active || arenaMode === 'decision'}
                onClick={() => void perform(() => api('/pause', {}))}
              >
                {state.snapshot?.status === 'paused'
                  ? t('Resume', '계속')
                  : t('Pause', '일시 정지')}
              </button>
              <button disabled={!active} onClick={() => void perform(() => api('/cancel', {}))}>
                {state.progress.active ? t('Stop benchmark', '벤치마크 중단') : t('Stop', '종료')}
              </button>
            </div>
            <p className="hint">
              {arenaMode === 'realtime'
                ? t(
                    'Gravity keeps moving while models respond. Failures retry every 0.5 seconds.',
                    '모델이 응답하는 동안에도 블록은 내려갑니다. 오류는 0.5초 간격으로 재시도합니다.',
                  )
                : t(
                    'Gravity is frozen. Both players see the same turn before either placement is applied. Requests run sequentially.',
                    '중력을 멈추고 양쪽 판단을 받은 뒤 동시에 적용합니다. 모델 요청은 순차 실행합니다.',
                  )}
            </p>
            {connectionsLoaded && !registeredModels.some((c) => c.available) && !active && (
              <p className="hint">
                {t(
                  'Connect a model in Settings to run a model match.',
                  '모델 대전을 시작하려면 설정에서 사용할 모델을 연결하세요.',
                )}{' '}
                <a className="page-link" href="#settings">
                  {t('Open settings', '설정 열기')} →
                </a>
              </p>
            )}
          </section>
          <div className="match-strip">
            <span className="status">{frames.length ? t('REPLAY', '다시 보기') : summary}</span>
            <span>
              {t('Turn', '턴')} {shown?.turn ?? 0} <b>·</b>{' '}
              {((shown?.elapsedMs ?? 0) / 1000).toFixed(1)}s
            </span>
            {state.progress.active ? (
              <a className="page-link" href="#benchmark">
                {t('Benchmark', '벤치마크')} · {state.progress.completed} / {state.progress.total} →
              </a>
            ) : (
              <span>
                {t('2 / 3 / 4 lines → 1 / 2 / 3 attack', '2 / 3 / 4줄 제거 → 1 / 2 / 3줄 공격')}
              </span>
            )}
          </div>
          {frames.length > 0 && (
            <div className="replay">
              <button onClick={() => setReplayPlaying(!replayPlaying)}>
                {replayPlaying ? 'Ⅱ' : '▶'}
              </button>
              <input
                aria-label="Replay position"
                type="range"
                min="0"
                max={frames.length - 1}
                value={frame}
                onChange={(e) => setFrame(Number(e.target.value))}
              />
              <span>
                {frame + 1}/{frames.length}
              </span>
              <button
                onClick={() => {
                  setFrames([]);
                  setReplayPlaying(false);
                }}
              >
                {t('Return to live', '실시간 화면')}
              </button>
            </div>
          )}
          <section className="arena">
            {[0, 1].map((p) => {
              const selected = connections.find((c) => c.id === arenaPlayers[p]),
                game = shown?.games[p] ?? emptyGame(),
                stats = shown?.stats[p];
              return (
                <article className={`player player-${p}`} key={p}>
                  <div className="player-top">
                    <span className="player-number">P{p + 1}</span>
                    <div className="player-selection">
                      <span className="field-label">{t('Controller', '플레이어')}</span>
                      <ModelPicker
                        label={`Player ${p + 1}`}
                        t={t}
                        value={[arenaPlayers[p]]}
                        disabled={active || !!demo}
                        description={
                          demo
                            ? t(
                                'Models cannot be changed in demo mode.',
                                '데모 모드에서는 모델을 변경할 수 없습니다.',
                              )
                            : undefined
                        }
                        options={[
                          ...connections.filter(
                            (c) =>
                              c.provider !== 'baseline' || (active && c.id === arenaPlayers[p]),
                          ),
                          ...(!demo && arenaMode === 'realtime'
                            ? [
                                {
                                  id: 'human',
                                  name: t('Human', '사람'),
                                  model: 'human',
                                  provider: 'local',
                                  available: arenaPlayers[1 - p] !== 'human',
                                },
                              ]
                            : []),
                          ...(!demo && p === 1
                            ? [
                                {
                                  id: 'none',
                                  name: t('Spectator / solo', '관전 / 솔로'),
                                  model: 'none',
                                  provider: 'local',
                                  available: true,
                                },
                              ]
                            : []),
                        ]}
                        onChange={([value]) =>
                          setPlayers(
                            (prev) =>
                              prev.map((id, i) => (i === p ? value : id)) as [string, string],
                          )
                        }
                      />
                    </div>
                  </div>
                  <div className="model-info" title={stats?.actualModel ?? selected?.model}>
                    {stats?.actualModel ?? selected?.model ?? arenaPlayers[p]}
                    <span>
                      {stats?.provider ?? selected?.provider ?? 'local'} · {t('reasoning', '추론')}{' '}
                      {selected?.reasoning ?? 'off'}
                    </span>
                  </div>
                  <div className="play-area">
                    <Board game={game} />
                    <aside>
                      <div className="piece-box">
                        <span>HOLD</span>
                        <Preview kind={game.hold} />
                      </div>
                      <div className="piece-box">
                        <span>NEXT</span>
                        <Preview kind={game.queue[0] ?? null} />
                      </div>
                      <dl className="score">
                        <div>
                          <dt>{t('Lines', '제거 줄')}</dt>
                          <dd>{game.lines}</dd>
                        </div>
                        <div>
                          <dt>{t('Attack', '공격')}</dt>
                          <dd>{stats?.sent ?? 0}</dd>
                        </div>
                        <div>
                          <dt>Tetris</dt>
                          <dd>{stats?.tetrises ?? 0}</dd>
                        </div>
                        <div>
                          <dt>{t('Score', '점수')}</dt>
                          <dd>{game.score}</dd>
                        </div>
                      </dl>
                    </aside>
                  </div>
                  <div className="metrics">
                    <div>
                      <span>{t('Last response', '최근 응답')}</span>
                      <b>
                        {stats?.lastMs === null || stats?.lastMs === undefined
                          ? '—'
                          : `${stats.lastMs.toLocaleString()} ms`}
                      </b>
                    </div>
                    <div>
                      <span>p50 / p95</span>
                      <b>
                        {stats?.p50Ms ?? '—'} / {stats?.p95Ms ?? '—'} ms
                      </b>
                    </div>
                    <div>
                      <span>{t('Valid / calls', '정상 / 호출')}</span>
                      <b>
                        {stats?.valid ?? 0} / {stats?.calls ?? 0}
                      </b>
                    </div>
                    <div>
                      <span>{t('Errors / stale', '오류 / 만료')}</span>
                      <b>
                        {stats?.failures ?? 0} / {stats?.stale ?? 0}
                      </b>
                    </div>
                  </div>
                  <details className="details">
                    <summary>{t('More metrics', '상세 지표')}</summary>
                    <p>
                      {t('Candidate / provider', '후보 계산 / API')}:{' '}
                      {Math.round(stats?.candidateMs ?? 0)} / {stats?.providerMs ?? 0} ms
                      <br />
                      {t('Placements / forced', '배치 / 강제 선택')}: {stats?.placements ?? 0} /{' '}
                      {stats?.forced ?? 0}
                      <br />
                      {t('Input / output tokens', '입력 / 출력 토큰')}: {stats?.inputTokens ?? '—'}{' '}
                      / {stats?.outputTokens ?? '—'}
                      <br />
                      {t('Reported cost', '보고된 비용')}:{' '}
                      {stats?.cost === null || stats?.cost === undefined
                        ? '—'
                        : `$${stats.cost.toFixed(6)}`}
                    </p>
                    {Object.entries(stats?.errors ?? {}).map(([code, count]) => (
                      <p key={code}>
                        {code}: {count}
                      </p>
                    ))}
                  </details>
                  {arenaPlayers[p] === 'human' && (
                    <div className="human-controls">
                      {(
                        ['left', 'counterclockwise', 'clockwise', 'right', 'hold', 'drop'] as const
                      ).map((action, i) => (
                        <button
                          key={action}
                          aria-label={action}
                          onClick={() => void perform(() => api('/action', { player: p, action }))}
                        >
                          {['←', '↶', '↷', '→', 'Hold', '↓ Drop'][i]}
                        </button>
                      ))}
                      <small>← → ↓ · ↑/X rotate · Z reverse · C hold · Space drop</small>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
          <section className="content-section connections">
            <h2>
              {demo ? t('Demo settings', '데모 설정') : t('Add your models', '내 모델 연결하기')}
            </h2>
            <p>
              {demo
                ? t(
                    'Models are fixed in this demo. View the saved prompts and model options in Settings.',
                    '데모에서는 모델이 고정되어 있습니다. 설정 화면에서 저장된 프롬프트와 모델 옵션을 확인하세요.',
                  )
                : t(
                    'Manage providers, API keys and saved model IDs from Settings.',
                    '설정 화면에서 공급자, API 키, 모델 ID를 추가하고 저장하세요.',
                  )}
            </p>
            <a className="page-link" href="#settings">
              {t('Open settings', '설정 열기')} →
            </a>
          </section>
        </>
      )}
      <footer>
        {t(
          'Assisted spatial decision benchmark. Results describe this task, not general intelligence.',
          '판단 보조 정보를 제공하는 공간 추론 벤치마크입니다. 이 과제의 결과가 일반 지능을 의미하지는 않습니다.',
        )}
        <span>MIT · v0.1.0</span>
      </footer>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
