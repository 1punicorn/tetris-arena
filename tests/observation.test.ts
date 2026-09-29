import { describe, expect, it } from 'vitest';
import { buildCandidates } from '../src/core/ai-candidates.js';
import { emptyGame, SHAPES, startGame, type Game } from '../src/core/engine.js';
import { makeProblem, observation } from '../src/core/observation.js';
import { applyPlacement } from '../src/core/runner.js';

describe('board context for line-clear decisions', () => {
  it('reports current locked-board danger separately from active and opponent cells', () => {
    const game = startGame(() => 0.5);
    game.board[18][0] = 'J';
    const opponent = startGame(() => 0.5);
    opponent.board[19] = Array.from({ length: 10 }, (_, x) => (x === 9 ? null : 'garbage'));
    const before = structuredClone([game, opponent]);
    const problem = makeProblem(game, opponent, [], 'context', 'decision');

    expect(problem.state.self).toMatchObject({
      height: 2,
      holes: 1,
      sum_height: 2,
      roughness: 2,
    });
    expect(problem.state.opponent).toMatchObject({
      height: 1,
      holes: 0,
      sum_height: 9,
      roughness: 1,
      wells: [{ column: 9, depth: 1, ready_rows: 1, filled_cells: 9 }],
    });
    expect([game, opponent]).toEqual(before);
    expect(observation(startGame(() => 0.5))).toMatchObject({
      height: 0,
      holes: 0,
      sum_height: 0,
      roughness: 0,
      wells: [],
    });
  });

  it.each([1, 2, 3, 4])(
    'offers and accurately describes a held-I %i-line clear on a high board',
    (lines) => {
      const game: Game = {
        ...startGame(() => 0.5),
        board: emptyGame().board,
        active: { kind: 'O', shape: SHAPES.O, x: 3, y: 0 },
        hold: 'I',
        queue: ['T'],
      };
      // A tall right edge makes recovery urgent; the open left shaft can clear
      // fewer than four rows without waiting to complete a Tetris setup.
      for (let y = 8; y < 20; y++) game.board[y][9] = 'J';
      for (let y = 20 - lines; y < 20; y++)
        game.board[y] = Array.from({ length: 10 }, (_, x) => (x === 0 ? null : 'J'));
      const problem = makeProblem(game, undefined, buildCandidates(game), 'recovery', 'decision');
      expect(problem.state.self).toMatchObject({ height: 12, holes: 0 });
      const entry = Object.entries(problem.candidates).find(
        ([, c]) => c.uses_hold && c.cleared_lines === lines && c.holes === 0,
      );
      expect(entry).toBeDefined();
      const [id, clear] = entry!;
      expect(clear.next_spawn_blocked).toBe(false);
      expect(problem.options[id]).toContain(`clear=${lines}`);
      expect(problem.options[id]).toContain(`height=${12 - lines}`);
      const landed = applyPlacement(game, clear, () => 0.5);
      expect(landed.lines).toBe(lines);
      expect(landed.status).toBe('playing');
      expect(observation(landed)).toMatchObject({
        holes: clear.holes,
        height: clear.max_height,
        sum_height: clear.aggregate_height,
        roughness: clear.bumpiness,
        wells: clear.wells,
      });
    },
  );
});
