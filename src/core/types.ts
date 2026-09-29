import type { Game, Kind, Piece } from './engine.js';

export interface Placement {
  target: Piece;
  uses_hold: boolean;
}
export interface Well {
  column: number;
  depth: number;
  ready_rows: number;
  filled_cells: number;
}
export interface Landing extends Placement {
  piece: Kind;
  hold_after: Kind | null;
  cleared_lines: number;
  holes: number;
  max_height: number;
  aggregate_height: number;
  bumpiness: number;
  key_presses: number;
  wells: Well[];
}
export interface Candidate extends Landing {
  action: 'left' | 'right' | 'clockwise' | 'counterclockwise' | 'drop' | 'hold';
  next_piece: Kind | null;
  next_spawn_blocked: boolean | null;
  follow_ups: Landing[];
}
// Local extraction contract: no generated or runtime dependency on the parent project.
export type ApiSchema<
  T extends 'TetrisPlacement' | 'TetrisLanding' | 'TetrisCandidate' | 'TetrisWell',
> = {
  TetrisPlacement: Placement;
  TetrisLanding: Landing;
  TetrisCandidate: Candidate;
  TetrisWell: Well;
}[T];
export interface DecisionProblem {
  instruction: string;
  state: Record<string, unknown>;
  options: Record<string, string>;
  candidates: Record<string, Candidate>;
}
export interface DecisionResult {
  choice: string;
  model: string;
  provider: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cost?: number;
}
export interface DecisionAgent {
  id: string;
  decide(problem: DecisionProblem, signal: AbortSignal): Promise<DecisionResult>;
}
export type PublicGame = Omit<Game, 'queue'> & { queue: Kind[] };
