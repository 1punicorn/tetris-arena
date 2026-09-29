import { z } from 'zod';
import { INSTRUCTION, RULES, STRATEGY, LEGEND, ATTACK_RULES } from './policy.js';

const text = z.string().max(16000);
export const PromptSchema = z
  .object({
    instruction: text.default(INSTRUCTION),
    strategy: z.array(z.string().max(4000)).max(40).default(STRATEGY),
    duelGoal: text.default(
      'Make the opponent top out; stay alive. Score does not decide the winner.',
    ),
    soloGoal: text.default('Survive; maximize clears and score.'),
    realtimeRules: text.default(RULES),
    decisionRules: text.default(
      RULES.replace(
        'Gravity continues during requests and movement.',
        'Gravity is frozen. Both placements resolve before attacks are applied simultaneously.',
      ),
    ),
    realtimeAttack: text.default(ATTACK_RULES),
    decisionAttack: text.default(
      ATTACK_RULES.replace('Garbage rises immediately;', 'Garbage rises after both placements;'),
    ),
    legend: text.default(LEGEND),
  })
  .strict();
export type Prompts = z.infer<typeof PromptSchema>;
export const DEFAULT_PROMPTS = PromptSchema.parse({});
export const ATTACK_PROMPTS: Prompts = {
  ...DEFAULT_PROMPTS,
  instruction:
    'Choose one legal landing. In a duel, aim to win by sending efficient attacks, especially triples and Tetrises. Follow state.strategy. Prefer a concrete multi-line attack plan over an unnecessary single when the stack can safely support it. Adapt to incoming danger instead of stacking indefinitely.',
  strategy: [
    '1. Survive to attack: reject a known top-out when another option survives. When holes, blocked access or rising height threaten survival, clear down immediately, including singles or doubles. Do not continue preparation just because it was the previous plan.',
    '2. Prefer efficient attacks: clear 4 sends 3 rows, clear 3 sends 2, clear 2 sends 1, and clear 1 sends 0. Among similarly safe plans, prioritize a Tetris or triple. Use the opponent board to judge whether an immediate smaller attack can finish the duel.',
    '3. Prepare with a concrete route: use current, next and hold pieces to build a reachable four-row edge well, or a three-row clear. Inspect now and each then alternative separately. You may defer a safe single to preserve a near-term triple or Tetris when it keeps the board accessible and leaves room for incoming garbage.',
    '4. Limit speculation: wells, ready_rows and filled_cells measure preparation, not attacks. Do not deepen a well beyond four just to improve those metrics. Avoid covered holes. At height >= 10 or when a clean attack route is lost, abandon preparation and reduce danger with available clears. This threshold is strategy, not an engine rule.',
    '5. Convert promptly: take the prepared triple or Tetris when available. Use hold to complete attacks; do not save I indefinitely. In solo play favor safe multi-line clears and score. Fewer inputs breaks otherwise equal ties.',
  ],
};
export const ExperimentSchema = z
  .object({
    prompts: PromptSchema.default(DEFAULT_PROMPTS),
    timeoutMs: z.number().int().min(100).max(120000).default(30000),
    attempts: z.number().int().min(1).max(5).default(3),
  })
  .strict();
export type Experiment = z.infer<typeof ExperimentSchema>;
export const DEFAULT_EXPERIMENT = ExperimentSchema.parse({});
