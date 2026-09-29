import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  addGarbage,
  emptyGame,
  startGame,
  step,
  fallInterval,
  type Game,
  type Action,
} from './engine.js';
import { placementAction } from './ai-placement.js';
import { buildCandidates } from './ai-candidates.js';
import { makeProblem } from './observation.js';
import { random } from './random.js';
import { POLICY_VERSION } from './policy.js';
import { safeError } from './errors.js';
import type { Candidate, DecisionAgent, Placement, PublicGame } from './types.js';
import type { RunConfig } from './run-config.js';

export type Status = 'ready' | 'playing' | 'paused' | 'finished';
export interface PlayerStats {
  calls: number;
  valid: number;
  failures: number;
  stale: number;
  forced: number;
  placements: number;
  sent: number;
  tetrises: number;
  errors: Record<string, number>;
  lastMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  candidateMs: number;
  providerMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cost: number | null;
  actualModel: string | null;
  provider: string | null;
}
export interface Snapshot {
  id: string;
  version: string;
  config: RunConfig;
  status: Status;
  reason: string | null;
  winner: number | null;
  elapsedMs: number;
  turn: number;
  games: [PublicGame, PublicGame];
  stats: [PlayerStats, PlayerStats];
}
export type RunEvent =
  | { type: 'state'; snapshot: Snapshot }
  | {
      type: 'decision';
      player: number;
      choice?: string;
      error?: string;
      ms: number;
      model?: string;
      provider?: string;
      at: number;
    };
export type Compute = (game: Game, signal: AbortSignal) => Promise<Candidate[]>;
const emptyStats = (): PlayerStats => ({
  calls: 0,
  valid: 0,
  failures: 0,
  stale: 0,
  forced: 0,
  placements: 0,
  sent: 0,
  tetrises: 0,
  errors: {},
  lastMs: null,
  p50Ms: null,
  p95Ms: null,
  candidateMs: 0,
  providerMs: 0,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cost: null,
  actualModel: null,
  provider: null,
});
/** The same legal input path drives visible playback and headless evaluation. */
export function* placementFrames(game: Game, placement: Placement, rng: () => number) {
  let current = game,
    target = { ...placement };
  for (let i = 0; i < 64; i++) {
    const action = placementAction(current, target);
    if (!action) throw new Error('unreachable_placement');
    current = step(current, action, rng);
    yield { game: current, locked: action === 'drop' };
    if (action === 'drop') return;
    if (action === 'hold') target = { ...target, uses_hold: false };
  }
  throw new Error('placement_path_limit');
}
export function applyPlacement(game: Game, placement: Placement, rng: () => number): Game {
  for (const frame of placementFrames(game, placement, rng)) if (frame.locked) return frame.game;
  throw new Error('unreachable_placement');
}
/** Resolve both placements first. Neither player observes or is interrupted by the other's move. */
export function resolveTurn(
  games: [Game, Game],
  placements: [Placement, Placement],
  pieces: [() => number, () => number],
  garbage: [() => number, () => number],
): { games: [Game, Game]; clears: [number, number]; attacks: [number, number] } {
  const next = games.map((g, i) => applyPlacement(g, placements[i], pieces[i])) as [Game, Game];
  return settleTurn(games, next, garbage);
}
function settleTurn(
  games: [Game, Game],
  next: [Game, Game],
  garbage: [() => number, () => number],
) {
  const clears = next.map((g, i) => g.lines - games[i].lines) as [number, number];
  const attacks = clears.map((c) => Math.max(0, c - 1)) as [number, number];
  return {
    games: next.map((g, i) =>
      addGarbage(
        g,
        Array.from({ length: attacks[1 - i] }, () => Math.floor(garbage[1 - i]() * 10)),
      ),
    ) as [Game, Game],
    clears,
    attacks,
  };
}
export class Runner {
  readonly id = randomUUID();
  status: Status = 'ready';
  reason: string | null = null;
  winner: number | null = null;
  turn = 0;
  games: [Game, Game];
  stats: [PlayerStats, PlayerStats] = [emptyStats(), emptyStats()];
  private pieces: [() => number, () => number];
  private garbage: [() => number, () => number];
  private controller = new AbortController();
  private started = 0;
  private pausedAt = 0;
  private pausedMs = 0;
  private ended = 0;
  private tick?: ReturnType<typeof setInterval>;
  private busy = [false, false];
  private generation = 0;
  private due = [0, 0];
  private nextCall = [0, 0];
  private plans: ({ placement: Placement; pieceId: number; board: Game['board'] } | null)[] = [
    null,
    null,
  ];
  private samples: number[][] = [[], []];
  private emittedAt = 0;
  constructor(
    readonly config: RunConfig,
    private agents: [DecisionAgent | null, DecisionAgent | null],
    private emit: (event: RunEvent) => void = () => {},
    private compute: Compute = async (game) => buildCandidates(game),
  ) {
    this.pieces = [random(config.seed + ':pieces'), random(config.seed + ':pieces')];
    this.garbage = [random(config.seed + ':garbage'), random(config.seed + ':garbage')];
    this.games = [
      startGame(this.pieces[0]),
      config.players[1] === 'none' ? emptyGame() : startGame(this.pieces[1]),
    ];
  }
  get elapsedMs() {
    return this.started
      ? Math.max(
          0,
          (this.ended || this.pausedAt || performance.now()) - this.started - this.pausedMs,
        )
      : 0;
  }
  snapshot(): Snapshot {
    return structuredClone({
      id: this.id,
      version: POLICY_VERSION,
      config: this.config,
      status: this.status,
      reason: this.reason,
      winner: this.winner,
      elapsedMs: Math.round(this.elapsedMs),
      turn: this.turn,
      games: this.games.map((g) => ({ ...g, queue: g.queue.slice(0, 1) })) as [Game, Game],
      stats: this.stats,
    });
  }
  private publish() {
    this.emit({ type: 'state', snapshot: this.snapshot() });
    this.emittedAt = performance.now();
  }
  start() {
    if (this.status !== 'ready') return;
    this.status = 'playing';
    this.started = performance.now();
    this.due = this.games.map((g) => performance.now() + fallInterval(g.level));
    this.publish();
    this.tick = setInterval(() => this.clock(), 20);
    if (this.config.mode === 'decision') void this.decisionLoop();
  }
  stop(reason = 'cancelled') {
    if (this.status === 'finished') return;
    this.ended = this.pausedAt || performance.now();
    this.status = 'finished';
    this.reason = reason;
    this.controller.abort();
    clearInterval(this.tick);
    this.generation++;
    this.plans = [null, null];
    this.publish();
  }
  pause() {
    if (this.config.mode !== 'realtime') return;
    if (this.status === 'playing') {
      this.status = 'paused';
      this.pausedAt = performance.now();
      this.generation++;
      this.plans = [null, null];
      this.publish();
    } else if (this.status === 'paused') {
      this.pausedMs += performance.now() - this.pausedAt;
      this.pausedAt = 0;
      this.status = 'playing';
      this.due = this.games.map((g) => performance.now() + fallInterval(g.level));
      this.publish();
    }
  }
  action(player: number, action: Action) {
    if (
      this.status !== 'playing' ||
      this.config.mode !== 'realtime' ||
      this.config.players[player] !== 'human'
    )
      return;
    this.move(player, action);
    this.publish();
  }
  private finishIfLost() {
    if (this.games[0].status === 'over' || this.games[1].status === 'over') {
      this.winner = this.games.every((g) => g.status === 'over')
        ? null
        : this.games[0].status === 'over'
          ? 1
          : 0;
      if (this.config.players[1] === 'none') this.winner = null;
      this.stop('top_out');
    }
  }
  private move(player: number, action: Action) {
    const old = this.games[player],
      next = step(old, action, this.pieces[player]);
    this.games[player] = next;
    if (next.board !== old.board) {
      const clear = next.lines - old.lines;
      this.stats[player].placements++;
      this.stats[player].tetrises += Number(clear === 4);
      const attack = Math.max(0, clear - 1);
      this.stats[player].sent += this.config.players[1] === 'none' ? 0 : attack;
      if (this.config.players[1] !== 'none' && attack) {
        this.games[1 - player] = addGarbage(
          this.games[1 - player],
          Array.from({ length: attack }, () => Math.floor(this.garbage[player]() * 10)),
        );
        this.plans[1 - player] = null;
      }
      this.due[player] = performance.now() + fallInterval(next.level);
    }
    this.finishIfLost();
  }
  private clock() {
    if (this.status !== 'playing') return;
    if (
      this.config.maxSeconds !== null &&
      this.elapsedMs >= this.config.maxSeconds * 1000 &&
      this.config.mode === 'realtime'
    ) {
      this.stop('time_limit');
      return;
    }
    if (this.config.mode === 'realtime')
      for (let p = 0; p < 2; p++) {
        if (this.status !== 'playing' || this.config.players[p] === 'none') continue;
        const now = performance.now();
        // Catch up simulation ticks after scheduling delays without borrowing model time.
        while (now >= this.due[p] && this.status === 'playing') {
          this.due[p] += fallInterval(this.games[p].level);
          this.move(p, 'tick');
        }
        if (!this.agents[p] || now < this.nextCall[p]) continue;
        const plan = this.plans[p],
          game = this.games[p];
        if (plan && game.pieceId === plan.pieceId && game.board === plan.board) {
          const action = placementAction(game, plan.placement);
          if (action) {
            this.move(p, action);
            this.nextCall[p] = now + 100;
            if (action === 'drop') this.plans[p] = null;
            else if (action === 'hold') {
              plan.pieceId = this.games[p].pieceId;
              plan.placement = { ...plan.placement, uses_hold: false };
            }
            continue;
          }
        }
        this.plans[p] = null;
        if (!this.busy[p]) void this.realtimeChoice(p);
      }
    if (this.status === 'playing' && performance.now() - this.emittedAt >= 100) this.publish();
  }
  private async choose(player: number, game: Game, opponent: Game | undefined): Promise<Placement> {
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(this.config.timeoutMs),
    ]);
    const start = performance.now();
    try {
      const all = await this.compute({ ...game, queue: game.queue.slice(0, 1) }, signal);
      signal.throwIfAborted();
      this.stats[player].candidateMs = performance.now() - start;
      const problem = makeProblem(
        game,
        opponent,
        all,
        `${this.config.seed}:options:${this.turn}:${game.pieceId}`,
        this.config.mode,
      );
      const keys = Object.keys(problem.candidates);
      if (!keys.length) throw new Error('no_candidates');
      if (keys.length === 1) {
        this.stats[player].forced++;
        return problem.candidates[keys[0]];
      }
      this.stats[player].calls++;
      const result = await this.agents[player]!.decide(problem, signal);
      signal.throwIfAborted();
      if (!problem.candidates[result.choice]) throw new Error('invalid_choice');
      const ms = performance.now() - start,
        stats = this.stats[player];
      stats.valid++;
      stats.lastMs = Math.round(ms);
      stats.providerMs = Math.round(result.latencyMs);
      stats.actualModel = result.model;
      stats.provider = result.provider;
      this.samples[player].push(ms);
      const ordered = [...this.samples[player]].sort((a, b) => a - b);
      stats.p50Ms = Math.round(ordered[Math.ceil(ordered.length * 0.5) - 1]);
      stats.p95Ms = Math.round(ordered[Math.ceil(ordered.length * 0.95) - 1]);
      for (const k of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cost'] as const)
        if (result[k] !== undefined) stats[k] = (stats[k] ?? 0) + result[k]!;
      this.emit({
        type: 'decision',
        player,
        choice: result.choice,
        ms,
        model: result.model,
        provider: result.provider,
        at: Math.round(this.elapsedMs),
      });
      return problem.candidates[result.choice];
    } catch (error) {
      if (this.controller.signal.aborted) throw error;
      const code = signal.aborted ? 'timeout' : safeError(error),
        stats = this.stats[player];
      stats.failures++;
      stats.errors[code] = (stats.errors[code] ?? 0) + 1;
      this.emit({
        type: 'decision',
        player,
        error: code,
        ms: performance.now() - start,
        at: Math.round(this.elapsedMs),
      });
      throw error;
    }
  }
  private async realtimeChoice(player: number) {
    this.busy[player] = true;
    const generation = this.generation,
      game = this.games[player];
    this.nextCall[player] = performance.now() + 250;
    try {
      const placement = await this.choose(
        player,
        game,
        this.config.players[1] === 'none' ? undefined : this.games[1 - player],
      );
      if (
        this.status === 'playing' &&
        generation === this.generation &&
        this.games[player].pieceId === game.pieceId &&
        this.games[player].board === game.board
      )
        this.plans[player] = { placement, pieceId: game.pieceId, board: game.board };
      else this.stats[player].stale++;
    } catch {
      this.nextCall[player] = performance.now() + 500;
    } finally {
      this.busy[player] = false;
    }
  }
  private async playPlacements(
    before: [Game, Game],
    placements: Placement[],
  ): Promise<[Game, Game]> {
    if (this.config.decisionStepMs === 0)
      return before.map((game, p) =>
        placements[p] ? applyPlacement(game, placements[p], this.pieces[p]) : game,
      ) as [Game, Game];
    const paths = placements.map((placement, p) =>
      placementFrames(before[p], placement, this.pieces[p]),
    );
    const placed: [Game, Game] = [...before];
    const done = paths.map(() => false);
    while (done.some((value) => !value)) {
      this.controller.signal.throwIfAborted();
      for (let p = 0; p < paths.length; p++) {
        if (done[p]) continue;
        const frame = paths[p].next();
        if (frame.done) throw new Error('unreachable_placement');
        placed[p] = frame.value.game;
        done[p] = frame.value.locked;
      }
      this.games = [...placed];
      this.publish();
      if (done.some((value) => !value))
        await delay(this.config.decisionStepMs, undefined, { signal: this.controller.signal });
    }
    return placed;
  }
  private async decisionLoop() {
    try {
      while (this.status === 'playing') {
        if (this.config.maxTurns !== null && this.turn >= this.config.maxTurns) {
          this.stop('turn_limit');
          break;
        }
        const snapshot = this.games;
        const placements: Placement[] = [];
        for (let p = 0; p < 2; p++) {
          if (this.config.players[p] === 'none') continue;
          let selected: Placement | undefined;
          for (let attempt = 0; attempt < this.config.attempts && !selected; attempt++) {
            try {
              selected = await this.choose(
                p,
                snapshot[p],
                this.config.players[1] === 'none' ? undefined : snapshot[1 - p],
              );
            } catch {
              if (this.controller.signal.aborted) return;
              if (attempt + 1 < this.config.attempts)
                await delay(500, undefined, { signal: this.controller.signal });
            }
          }
          if (!selected) {
            this.stop('model_failure');
            return;
          }
          placements.push(selected);
        }
        if (this.status !== 'playing') return;
        const placed = await this.playPlacements(snapshot, placements);
        if (this.status !== 'playing') return;
        if (this.config.players[1] === 'none') {
          const before = snapshot[0];
          this.games = placed;
          this.stats[0].placements++;
          this.stats[0].tetrises += Number(this.games[0].lines - before.lines === 4);
        } else {
          const result = settleTurn(snapshot, placed, this.garbage);
          this.games = result.games;
          for (let p = 0; p < 2; p++) {
            this.stats[p].placements++;
            this.stats[p].tetrises += Number(result.clears[p] === 4);
            this.stats[p].sent += result.attacks[p];
          }
        }
        this.turn++;
        this.finishIfLost();
        if (this.status === 'playing') this.publish();
        await delay(0, undefined, { signal: this.controller.signal });
      }
    } catch {
      if (this.status !== 'finished') this.stop('execution_failure');
    }
  }
}
