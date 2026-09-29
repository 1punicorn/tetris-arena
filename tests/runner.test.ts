import { it, expect, vi } from 'vitest';
import { Runner, resolveTurn, type Snapshot } from '../src/core/runner.js';
import { RunConfigSchema, BenchConfigSchema, schedule } from '../src/core/run-config.js';
import { createAgent } from '../src/providers/agents.js';
import { ModelError } from '../src/core/errors.js';
import { startGame, SHAPES, type Game } from '../src/core/engine.js';
import { random } from '../src/core/random.js';
import { makeProblem } from '../src/core/observation.js';
import { buildCandidates } from '../src/core/ai-candidates.js';
import type { DecisionAgent, Candidate } from '../src/core/types.js';
import { CandidatePool } from '../src/server/candidates.js';
const result = (choice: string) => ({ choice, model: 'fixture', provider: 'mock', latencyMs: 1 });
async function run(seed = 'repro', swapped = false) {
  const players: [string, string] = swapped ? ['random', 'heuristic'] : ['heuristic', 'random'];
  const config = RunConfigSchema.parse({ mode: 'decision', seed, maxTurns: 12, players });
  const agent = players.map((id) => createAgent(id, [], seed)) as [DecisionAgent, DecisionAgent];
  return new Promise<Snapshot>((resolve) => {
    new Runner(config, agent, (e) => {
      if (e.type === 'state' && e.snapshot.status === 'finished') resolve(e.snapshot);
    }).start();
  });
}
it('reproduces game outcomes and swaps the same agents between sides', async () => {
  const a = await run(),
    b = await run(),
    c = await run('repro', true);
  expect(a.games).toEqual(b.games);
  expect(a.games[0]).toEqual(c.games[1]);
  expect(a.games[1]).toEqual(c.games[0]);
  expect(a.stats.map((s) => s.placements)).toEqual([12, 12]);
  expect(a.reason).toBe('turn_limit');
});
it('offers the exact same seeded question regardless of agent or hidden bag', () => {
  const game = startGame(random('fair'));
  const a = makeProblem(game, game, buildCandidates(game), 'options', 'decision');
  const altered = { ...game, queue: [game.queue[0], ...game.queue.slice(1).reverse()] };
  const b = makeProblem(altered, altered, buildCandidates(altered), 'options', 'decision');
  expect(a).toEqual(b);
  expect(Object.keys(a.options).length).toBeLessThanOrEqual(26);
  expect(a.state).toHaveProperty('self.board');
});
it('applies both clears before either garbage attack', () => {
  const game = startGame(random(1));
  game.active = {
    kind: 'I',
    shape: SHAPES.I[0].map((_, y) => SHAPES.I.map((row) => row[y])),
    x: 0,
    y: 0,
  };
  game.board = Array.from({ length: 20 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => (y >= 16 && x !== 1 ? 'J' : null)),
  );
  const placement = { target: { ...game.active, y: 16 }, uses_hold: false };
  const resolved = resolveTurn(
    [game, structuredClone(game)],
    [placement, placement],
    [random(2), random(2)],
    [() => 0.3, () => 0.7],
  );
  expect(resolved.clears).toEqual([4, 4]);
  expect(resolved.attacks).toEqual([3, 3]);
  expect(resolved.games.map((g) => g.lines)).toEqual([4, 4]);
  expect(resolved.games[0].board[19][7]).toBeNull();
  expect(resolved.games[1].board[19][3]).toBeNull();
});
it('retries a failed decision after 500ms; failed runs do not count as losses', async () => {
  const call = vi.fn(async () => {
    throw new ModelError('http_503');
  });
  let end!: Snapshot;
  const runner = new Runner(
    RunConfigSchema.parse({ mode: 'decision', attempts: 2 }),
    [{ id: 'x', decide: call }, createAgent('random', [], '1')],
    (e) => {
      if (e.type === 'state') end = e.snapshot;
    },
  );
  const start = performance.now();
  runner.start();
  await vi.waitFor(() => expect(end.status).toBe('finished'), { timeout: 3000 });
  expect(performance.now() - start).toBeGreaterThanOrEqual(500);
  expect(call).toHaveBeenCalledTimes(2);
  expect(end.reason).toBe('model_failure');
  expect(end.winner).toBeNull();
  expect(end.stats[0].errors.http_503).toBe(2);
});
it('continues gravity while a request is pending, and aborts it on cancellation', async () => {
  let signal: AbortSignal | undefined;
  const agent: DecisionAgent = {
    id: 'slow',
    decide: async (_, s) => {
      signal = s;
      return new Promise((_, reject) =>
        s.addEventListener('abort', () => reject(s.reason), { once: true }),
      );
    },
  };
  const runner = new Runner(RunConfigSchema.parse({ players: ['slow', 'none'], maxSeconds: 5 }), [
    agent,
    null,
  ]);
  runner.start();
  await vi.waitFor(() => expect(signal).toBeDefined());
  await vi.waitFor(() => expect(runner.games[0].active!.y).toBeGreaterThan(0), { timeout: 2000 });
  runner.stop();
  expect(signal!.aborted).toBe(true);
  expect(runner.status).toBe('finished');
});
it('retries real-time errors at 500ms until the match ends', async () => {
  const times: number[] = [];
  const agent: DecisionAgent = {
    id: 'bad',
    decide: async () => {
      times.push(performance.now());
      throw new ModelError('http_503');
    },
  };
  const runner = new Runner(RunConfigSchema.parse({ players: ['bad', 'none'], maxSeconds: 2 }), [
    agent,
    null,
  ]);
  runner.start();
  await vi.waitFor(() => expect(runner.status).toBe('finished'), { timeout: 3000 });
  expect(times.length).toBeGreaterThanOrEqual(3);
  expect(times.every((v, i) => i === 0 || v - times[i - 1] >= 490)).toBe(true);
  expect(runner.reason).toBe('time_limit');
});
it('handles candidate failures and excludes forced moves from calls', async () => {
  const game = startGame(random('1:pieces')),
    only = buildCandidates(game)[0];
  const agent = { id: 'unused', decide: vi.fn() };
  const snapshot = await new Promise<Snapshot>((resolve) => {
    const runner = new Runner(
      RunConfigSchema.parse({ mode: 'decision', players: ['unused', 'none'], maxTurns: 1 }),
      [agent, null],
      (e) => {
        if (e.type === 'state' && e.snapshot.status === 'finished') resolve(e.snapshot);
      },
      async () => [only],
    );
    runner.start();
  });
  expect(agent.decide).not.toHaveBeenCalled();
  expect(snapshot.stats[0].forced).toBe(1);
  expect(snapshot.stats[0].calls).toBe(0);
});
it('computes candidates through the production worker interface', async () => {
  const pool = new CandidatePool(1);
  try {
    const game = startGame(random(5));
    const all = await pool.compute(game, AbortSignal.timeout(5000));
    expect(all).toEqual(buildCandidates(game));
  } finally {
    pool.close();
  }
});
it('schedules all pairs, seeds and reversed sides and prohibits human evaluation', () => {
  const runs = schedule(BenchConfigSchema.parse({ models: ['a', 'b', 'c'], seeds: ['1', '2'] }));
  expect(runs).toHaveLength(12);
  expect(runs[0].players).toEqual(['a', 'b']);
  expect(runs[1].players).toEqual(['b', 'a']);
  expect(() => RunConfigSchema.parse({ mode: 'decision', players: ['human', 'random'] })).toThrow();
  expect(() => RunConfigSchema.parse({ players: ['human', 'human'] })).toThrow();
});
