# Verified capabilities

Validation records the distinction between executable adapter support and an actual paid/local model connection. Last implementation check: 2026-09-29.

| Surface                                                          | Evidence                                                                                                                              | Limit                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Engine, hold, garbage, reachable targets, well/attack candidates | Original regression tests plus extracted-engine tests                                                                                 | Not official SRS/Guideline Tetris                                                                   |
| Equal observations, paired seeds, simultaneous turn resolution   | Automated deterministic tests                                                                                                         | Real-time scheduling and remote inference are not deterministic                                     |
| Baseline AI vs AI                                                | Actual local server, CLI and browser runs                                                                                             | Baselines are explicit comparators, not fallbacks                                                   |
| OpenAI-compatible Chat Completions                               | Actual AI SDK against a local HTTP protocol fixture; schema, JSON text, errors, options, reasoning flag, inventory and bounds checked | Live DeepSeek V4.1 Flash through OpenRouter also succeeded; Ollama/vLLM/Groq/etc. remain unverified |
| OpenRouter native Decisions                                      | Protocol fixture verifies shared state/options and response probabilities                                                             | Live Jev 1.13, Kev 4B and Solar Decide calls and short paired games succeeded                       |
| OpenRouter Decisions inventory                                   | Public live catalog successfully queried                                                                                              | Inventory does not prove inference availability or speed                                            |
| OpenAI, Anthropic, Google, Azure, Bedrock, Vertex                | Official SDK adapters compile; configuration paths implemented                                                                        | Credentials/deployments unavailable; live inference not verified                                    |
| Mobile and desktop UI, replay, navigation/reconnect              | Chromium production-build integration tests; rendered mobile inspection                                                               | Other browser engines not yet exercised                                                             |
| Local HTTP boundary and artifacts                                | Host/origin/content-type/body-size tests, traversal rejection, flush/export/replay tests                                              | Intended for a single trusted local owner, not internet hosting                                     |

Public Decisions discovery returned `typesafe/jev-1.13`, `~typesafe/jev-latest`, `jaredpalmer/kev-4b`, `upstage/solar-decide` and Respan models on the check date. Availability can change. The example profiles are not a frozen universal model catalog.

## Reproduce locally

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
pnpm bench --config bench.example.json
```

To validate a real provider, configure a profile and credentials, select a small decision-mode turn limit, run one match, then inspect `summary.json` and `metadata.json`. Verify actual model, valid calls, errors, reasoning usage and elapsed/provider latency. Increase sample size only after the protocol succeeds. Do not present a stubbed protocol test as evidence of model quality.

## Live connection smoke test

Using an operator-supplied OpenRouter key (not included in the repository), the same initial assisted observation produced valid choices from all four configured models:

| Reported model                  | Single-request provider latency | Result                                             |
| ------------------------------- | ------------------------------- | -------------------------------------------------- |
| `typesafe/jev-1.13-20260917`    | 313 ms                          | Valid native decision                              |
| `jaredpalmer/kev-4b-20260924`   | 1,401 ms                        | Valid native decision                              |
| `upstage/solar-decide-20260928` | 1,316 ms                        | Valid native decision                              |
| `deepseek/deepseek-v4.1-flash`  | 349 ms                          | Valid structured JSON; 0 reported reasoning tokens |

Each then completed two 2-turn decision matches against the heuristic baseline with swapped seats: 8 matches total, all 16 remote choices accepted and applied, no errors. An 8-second real-time Jev vs DeepSeek match completed with 12 and 5 placements respectively, 12 and 6 accepted responses, no provider failures, and 0 reported DeepSeek reasoning tokens. A final accepted response need not finish its movement before a time limit. These are connection and execution smoke tests, **not a model-quality ranking or a stable latency benchmark**.

The full no-key default CLI benchmark also completed: 5 seeds × 2 seat orders, 10 finished matches, reproducible swapped outcomes. Automated checks include 86 unit/protocol/integration tests and 5 Chromium scenarios at this revision.

## Line-clear policy regression

An archived v1 decision-mode Jev vs DeepSeek game (seed `1`) ended after 21 placements: Jev cleared no lines, despite having reachable clearing candidates from placement 6 onward. At placement 13 it passed up a three-line clear that would have lowered its board from height 8 to 5 and reduced holes from 2 to 1. Gravity was frozen and there were no request failures or stale answers. The v1 instructions explicitly preferred Tetris preparation to small clears and lowering the board.

On 2026-09-29, four pre-decision boards from that game were submitted again to reported model `typesafe/jev-1.13-20260917`. The candidates and their seeded option ordering were identical between versions. V2 changed the shared strategy to prioritize survival and useful clears and added current-board geometry to the observations.

| Recorded placement | Lines chosen with v1 | Lines chosen with v2 |
| ------------------ | -------------------- | -------------------- |
| 7                  | 0                    | 2                    |
| 12                 | 0                    | 2                    |
| 13                 | 0                    | 3                    |
| 18                 | 0                    | 3                    |

A v2 decision-mode duel with the same seed and players reached 49 completed placements. Jev cleared 22 lines and had height 2; DeepSeek cleared 15 lines. Both boards were still alive when a Jev response failed probability-distribution validation. This diagnostic run allowed only one request attempt and therefore ended as `model_failure`, not a win or loss.

A second run with the default three-attempt policy and 30-second timeout completed the 60-turn validation limit with both players alive: Jev cleared 20 lines (height 9), DeepSeek cleared 22 (height 7). Three invalid-distribution responses and one timeout from Jev recovered through the existing retry mechanism; DeepSeek had no failures. Both runs used actual provider decisions, frozen gravity and no visual pacing. These targeted checks show the observed stacking failure improved; they do not establish a general model ranking or guarantee future choices.

Automated regressions verify current-board danger measurements, held-I single/double/triple/Tetris clear options on a high board, agreement between candidate metrics and actual engine outcomes, and delivery of the same strategy and state through both provider protocols.
