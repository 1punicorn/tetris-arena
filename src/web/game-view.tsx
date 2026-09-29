import React from 'react';
import {
  emptyGame,
  visibleBoard,
  landingPiece,
  SHAPES,
  type Game,
  type Kind,
} from '../core/engine.js';
import type { Snapshot } from '../core/runner.js';

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
export function PlayerGame({
  snapshot,
  player,
  t,
}: {
  snapshot: Snapshot | null;
  player: number;
  t: (en: string, ko: string) => string;
}) {
  const game = snapshot?.games[player] ?? emptyGame();
  const stats = snapshot?.stats[player];
  return (
    <>
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
          {t('Candidate / provider', '후보 계산 / API')}: {Math.round(stats?.candidateMs ?? 0)} /{' '}
          {stats?.providerMs ?? 0} ms
          <br />
          {t('Placements / forced', '배치 / 강제 선택')}: {stats?.placements ?? 0} /{' '}
          {stats?.forced ?? 0}
          <br />
          {t('Input / output tokens', '입력 / 출력 토큰')}: {stats?.inputTokens ?? '—'} /{' '}
          {stats?.outputTokens ?? '—'}
          <br />
          {t('Reported cost', '보고된 비용')}:{' '}
          {stats?.cost === null || stats?.cost === undefined ? '—' : `$${stats.cost.toFixed(6)}`}
        </p>
        {Object.entries(stats?.errors ?? {}).map(([code, count]) => (
          <p key={code}>
            {code}: {count}
          </p>
        ))}
      </details>
    </>
  );
}
