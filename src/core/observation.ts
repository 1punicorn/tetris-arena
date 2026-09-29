import type { Game } from './engine.js';
import type { Candidate, DecisionProblem, Landing } from './types.js';
import { shuffled } from './random.js';
import { boardMetrics } from './board-analysis.js';
import { DEFAULT_PROMPTS, type Prompts } from './experiment.js';

function describe(item: Landing) {
  const wells =
    item.wells.map((w) => `${w.column}:${w.depth}:${w.ready_rows}:${w.filled_cells}`).join(',') ||
    '-';
  return `piece=${item.piece} hold=${Number(item.uses_hold)} reserve=${item.hold_after ?? '-'} x=${item.target.x} y=${item.target.y} shape=${item.target.shape.map((r) => r.join('')).join('/')} clear=${item.cleared_lines} attack=${Math.max(0, item.cleared_lines - 1)} holes=${item.holes} height=${item.max_height} sum_height=${item.aggregate_height} roughness=${item.bumpiness} wells=${wells} keys=${item.key_presses}`;
}
export function observation(game: Game) {
  const metrics = boardMetrics(game.board);
  return {
    board: game.board.map((row) =>
      row.map((c) => (c === null ? '.' : c === 'garbage' ? 'G' : c)).join(''),
    ),
    active: game.active && { ...game.active, shape: game.active.shape.map((row) => row.join('')) },
    next: game.queue[0] ?? null,
    hold: game.hold,
    can_hold: game.canHold,
    holes: metrics.holes,
    height: metrics.max_height,
    sum_height: metrics.aggregate_height,
    roughness: metrics.bumpiness,
    wells: metrics.wells,
    score: game.score,
    lines: game.lines,
    level: game.level,
  };
}
export function makeProblem(
  game: Game,
  opponent: Game | undefined,
  all: Candidate[],
  seed: string,
  mode: 'realtime' | 'decision',
  prompts: Prompts = DEFAULT_PROMPTS,
): DecisionProblem {
  const candidates: Record<string, Candidate> = {},
    options: Record<string, string> = {};
  shuffled(all.slice(0, 26), seed).forEach((item, index) => {
    const key = `option_${index}`;
    candidates[key] = item;
    options[key] =
      `now: ${describe(item)}\nnext=${item.next_piece ?? 'unknown'} spawn_blocked=${item.next_spawn_blocked === null ? 'unknown' : Number(item.next_spawn_blocked)}`;
    for (const future of item.follow_ups)
      options[key] +=
        `\nthen: ${describe(future)} total_clear=${item.cleared_lines + future.cleared_lines} total_attack=${Math.max(0, item.cleared_lines - 1) + Math.max(0, future.cleared_lines - 1)}`;
  });
  return {
    instruction: prompts.instruction,
    candidates,
    options,
    state: {
      game: opponent ? 'Tetris duel' : 'Tetris solo',
      goal: opponent ? prompts.duelGoal : prompts.soloGoal,
      rules: mode === 'realtime' ? prompts.realtimeRules : prompts.decisionRules,
      strategy: prompts.strategy,
      legend: prompts.legend,
      self: observation(game),
      ...(opponent
        ? {
            opponent: observation(opponent),
            attack_rules: mode === 'realtime' ? prompts.realtimeAttack : prompts.decisionAttack,
          }
        : {}),
    },
  };
}
