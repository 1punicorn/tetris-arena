import React, { useEffect, useState } from 'react';
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
import './style.css';

type Connection = {
  id: string;
  name: string;
  model: string;
  provider: string;
  reasoning: string;
  available: boolean;
  output?: string;
};
type State = {
  snapshot: Snapshot | null;
  progress: { total: number; completed: number; active: boolean };
  error: string | null;
};
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    '/api' + path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'request_failed');
  return data;
}
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
function App() {
  const [ko, setKo] = useState(false),
    t = (en: string, kr: string) => (ko ? kr : en);
  const [connections, setConnections] = useState<Connection[]>([]),
    [players, setPlayers] = useState<[string, string]>(['heuristic', 'random']);
  const [overrides, setOverrides] = useState<Record<string, string>>({}),
    [inventories, setInventories] = useState<Record<string, string[]>>({});
  const [mode, setMode] = useState<'realtime' | 'decision'>('realtime'),
    [seed, setSeed] = useState('1'),
    [limit, setLimit] = useState<number | null>(null),
    [turns, setTurns] = useState<number | null>(null);
  const [state, setState] = useState<State>({
      snapshot: null,
      progress: { total: 0, completed: 0, active: false },
      error: null,
    }),
    [connected, setConnected] = useState(false);
  const [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [results, setResults] = useState<Snapshot[]>([]);
  const [frames, setFrames] = useState<Snapshot[]>([]),
    [frame, setFrame] = useState(0),
    [replayPlaying, setReplayPlaying] = useState(false);
  const [benchModels, setBenchModels] = useState(['heuristic', 'random']),
    [seeds, setSeeds] = useState('1,2,3,4,5');
  const active =
    state.progress.active ||
    (!!state.snapshot && ['playing', 'paused'].includes(state.snapshot.status));
  const shown = frames.length ? frames[frame] : state.snapshot;
  const runConfig = {
    mode,
    players,
    seed,
    maxSeconds: limit,
    maxTurns: turns,
    modelOverrides: overrides,
  };
  const refresh = () =>
    api<Snapshot[]>('/results')
      .then(setResults)
      .catch(() => {});
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
    void api<Connection[]>('/connections')
      .then(setConnections)
      .catch((e) => setError(e.message));
    void refresh();
    const events = new EventSource('/api/events');
    events.addEventListener('state', (event) => {
      setState(JSON.parse(event.data));
      setConnected(true);
    });
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, []);
  useEffect(() => {
    const config = state.snapshot?.config;
    if (config) {
      setPlayers(config.players);
      setOverrides(config.modelOverrides);
      // A finished run is history, not the next visitor's match configuration.
      if (state.snapshot?.status !== 'finished') {
        setMode(config.mode);
        setSeed(config.seed);
        setLimit(config.maxSeconds);
        setTurns(config.maxTurns);
      }
    }
  }, [state.snapshot?.id]);
  useEffect(() => {
    document.documentElement.lang = ko ? 'ko' : 'en';
  }, [ko]);
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
      if ((e.target as HTMLElement).closest('input,select,textarea,button') || frames.length)
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
  }, [state.snapshot?.config.players.join(','), frames.length]);
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
      <header>
        <div className="brand">
          <span className="mark">▦</span>
          <div>
            <h1>
              Tetris <strong>AI Bench</strong>
            </h1>
            <p>
              {t(
                'Watch models think. Measure how they play.',
                '모델의 판단을 관찰하고, 플레이를 비교하세요.',
              )}
            </p>
          </div>
        </div>
        <div className="header-actions">
          <span className={`connection ${connected ? 'online' : ''}`}>
            {connected ? t('Local server', '로컬 서버') : t('Reconnecting…', '다시 연결 중…')}
          </span>
          <button className="small" onClick={() => setKo(!ko)}>
            {ko ? 'English' : '한국어'}
          </button>
          <a href="https://github.com/hurxxxx/tetris" target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </div>
      </header>
      <section className="setup" aria-label="Match settings">
        <div className="setup-title">
          <h2>{t('Arena', '대전')}</h2>
          <span className="badge">{t('ASSISTED · 26 CHOICES', '판단 보조 · 26개 선택지')}</span>
        </div>
        <div className="settings">
          <label>
            {t('Mode', '모드')}
            <select
              aria-label="Mode"
              value={mode}
              disabled={active}
              onChange={(e) => {
                const m = e.target.value as typeof mode;
                setMode(m);
                if (m === 'decision')
                  setPlayers(
                    (p) => p.map((x) => (x === 'human' ? 'heuristic' : x)) as [string, string],
                  );
              }}
            >
              <option value="realtime">{t('Real-time match', '실시간 대전')}</option>
              <option value="decision">{t('Decision evaluation', '판단 평가')}</option>
            </select>
          </label>
          <label>
            {t('Seed', '시드')}
            <input
              aria-label="Seed"
              value={seed}
              maxLength={100}
              disabled={active}
              onChange={(e) => setSeed(e.target.value)}
            />
          </label>
          <label>
            {mode === 'realtime'
              ? t('Time limit (s)', '제한 시간 (초)')
              : t('Turn limit', '최대 턴')}
            <input
              aria-label="Run limit"
              type="number"
              min="1"
              max={mode === 'realtime' ? 600 : 2000}
              disabled={active}
              value={(mode === 'realtime' ? limit : turns) ?? ''}
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
            disabled={active || pending || !connected}
            onClick={() =>
              void perform(async () => {
                setFrames([]);
                await api('/runs', runConfig);
              })
            }
          >
            {t('Start match', '대전 시작')} →
          </button>
          <button
            disabled={!active || mode === 'decision'}
            onClick={() => void perform(() => api('/pause', {}))}
          >
            {state.snapshot?.status === 'paused' ? t('Resume', '계속') : t('Pause', '일시 정지')}
          </button>
          <button disabled={!active} onClick={() => void perform(() => api('/cancel', {}))}>
            {t('Stop', '종료')}
          </button>
        </div>
        <p className="hint">
          {mode === 'realtime'
            ? t(
                'Gravity keeps moving while models respond. Failures retry every 0.5 seconds.',
                '모델이 응답하는 동안에도 블록은 내려갑니다. 오류는 0.5초 간격으로 재시도합니다.',
              )
            : t(
                'Gravity is frozen. Both players see the same turn before either placement is applied. Requests run sequentially.',
                '중력을 멈추고 양쪽 판단을 받은 뒤 동시에 적용합니다. 모델 요청은 순차 실행합니다.',
              )}
        </p>
      </section>
      {(error || state.error) && (
        <div role="alert" className="error">
          {error || state.error} <button onClick={() => setError('')}>×</button>
        </div>
      )}
      <div className="match-strip">
        <span className="status">{frames.length ? t('REPLAY', '다시 보기') : summary}</span>
        <span>
          {t('Turn', '턴')} {shown?.turn ?? 0} <b>·</b>{' '}
          {((shown?.elapsedMs ?? 0) / 1000).toFixed(1)}s
        </span>
        <span>
          {state.progress.active
            ? `${state.progress.completed + 1} / ${state.progress.total}`
            : t('2 / 3 / 4 lines → 1 / 2 / 3 attack', '2 / 3 / 4줄 제거 → 1 / 2 / 3줄 공격')}
        </span>
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
          const selected = connections.find((c) => c.id === players[p]),
            game = shown?.games[p] ?? emptyGame(),
            stats = shown?.stats[p];
          return (
            <article className={`player player-${p}`} key={p}>
              <div className="player-top">
                <span className="player-number">P{p + 1}</span>
                <div className="player-selection">
                  <label>
                    {t('Controller', '플레이어')}
                    <select
                      aria-label={`Player ${p + 1}`}
                      value={players[p]}
                      disabled={active}
                      onChange={(e) =>
                        setPlayers(
                          (prev) =>
                            prev.map((id, i) => (i === p ? e.target.value : id)) as [
                              string,
                              string,
                            ],
                        )
                      }
                    >
                      {connections.map((c) => (
                        <option value={c.id} key={c.id} disabled={!c.available}>
                          {c.name}
                          {!c.available ? ' · setup required' : ''}
                        </option>
                      ))}
                      {mode === 'realtime' && (
                        <option value="human" disabled={players[1 - p] === 'human'}>
                          {t('Human', '사람')}
                        </option>
                      )}
                      {p === 1 && (
                        <option value="none">{t('Spectator / solo', '관전 / 솔로')}</option>
                      )}
                    </select>
                  </label>
                </div>
              </div>
              {selected && selected.provider !== 'baseline' && (
                <div className="model-picker">
                  <input
                    aria-label={`Player ${p + 1} model`}
                    list={`models-${p}`}
                    disabled={active}
                    value={overrides[selected.id] ?? selected.model}
                    onChange={(e) => setOverrides((v) => ({ ...v, [selected.id]: e.target.value }))}
                  />
                  <datalist id={`models-${p}`}>
                    {(inventories[selected.id] ?? [selected.model]).map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                  <button
                    className="small"
                    disabled={pending}
                    onClick={() =>
                      void perform(async () => {
                        const models = await api<string[]>(`/connections/${selected.id}/models`);
                        setInventories((v) => ({ ...v, [selected.id]: models }));
                      })
                    }
                  >
                    {t('Load models', '모델 조회')}
                  </button>
                </div>
              )}
              <div className="model-info" title={stats?.actualModel ?? selected?.model}>
                {stats?.actualModel ??
                  (selected ? (overrides[selected.id] ?? selected.model) : players[p])}
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
                  {t('Input / output tokens', '입력 / 출력 토큰')}: {stats?.inputTokens ?? '—'} /{' '}
                  {stats?.outputTokens ?? '—'}
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
              {players[p] === 'human' && (
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
      <section className="panel benchmark">
        <div>
          <h2>{t('Paired benchmark', '반복 벤치마크')}</h2>
          <p className="hint">
            {t(
              'Every pair, identical seeds, swapped sides. Each mode is reported separately.',
              '모든 모델 조합을 같은 시드에서 양쪽 자리를 바꾸어 평가합니다.',
            )}
          </p>
        </div>
        <div className="checks">
          {connections
            .filter((c) => c.available)
            .map((c) => (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={benchModels.includes(c.id)}
                  disabled={active}
                  onChange={(e) =>
                    setBenchModels((v) =>
                      e.target.checked ? [...v, c.id] : v.filter((id) => id !== c.id),
                    )
                  }
                />
                {c.name}
              </label>
            ))}
        </div>
        <div className="bench-controls">
          <label>
            {t('Seeds (comma separated)', '시드 (쉼표로 구분)')}
            <input value={seeds} disabled={active} onChange={(e) => setSeeds(e.target.value)} />
          </label>
          <span>
            {benchModels.length *
              (benchModels.length - 1) *
              seeds.split(',').filter((s) => s.trim()).length}{' '}
            {t('matches', '경기')} · {mode}
          </span>
          <button
            disabled={active || pending || benchModels.length < 2}
            onClick={() =>
              void perform(async () => {
                setFrames([]);
                await api('/bench', {
                  models: benchModels,
                  seeds: seeds
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                  run: runConfig,
                });
              })
            }
          >
            {t('Run benchmark', '벤치마크 실행')}
          </button>
        </div>
      </section>
      <section className="panel">
        <div className="section-title">
          <h2>{t('Results & replay', '결과 및 다시 보기')}</h2>
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
                  <strong>{s.config.players.join(' vs ')}</strong>
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
              </div>
            ))}
          </div>
        )}
      </section>
      <details className="panel connections">
        <summary>{t('Connect a model or local server', '모델 및 로컬 서버 연결')}</summary>
        <p>
          {t(
            'Copy connections.example.json to connections.local.json, keep only the profiles you need, and put credentials in .env. Model IDs can be loaded above or entered manually. Reasoning is disabled by default; confirm support for each endpoint/model in your profile.',
            'connections.example.json을 connections.local.json으로 복사하고 필요한 연결만 남기세요. API 키는 .env에 저장합니다. 모델 ID는 직접 입력하거나 조회할 수 있습니다. 추론은 기본적으로 꺼지며 각 모델의 지원 여부를 설정에서 확인해야 합니다.',
          )}
        </p>
        <pre>cp connections.example.json connections.local.json{'\n'}cp .env.example .env</pre>
        <button
          disabled={active}
          onClick={() =>
            void perform(async () =>
              setConnections(await api<Connection[]>('/connections/reload', {})),
            )
          }
        >
          {t('Reload connections', '연결 설정 다시 읽기')}
        </button>{' '}
        <a href="https://github.com/hurxxxx/tetris#providers" target="_blank" rel="noreferrer">
          {t('Provider setup ↗', '공급자 설정 ↗')}
        </a>
      </details>
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
