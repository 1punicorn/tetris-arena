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

The full no-key default CLI benchmark also completed: 5 seeds × 2 seat orders, 10 finished matches, reproducible swapped outcomes. Automated checks include 108 unit/protocol/integration tests and 9 Chromium scenarios at this revision.

## Persistent model settings

SQLite/API regressions cover connection creation, editing, duplication, deletion, key replacement/removal, credential redaction, owner-only database/WAL permissions, reopening the database and one-time legacy migration without resurrecting deleted profiles. A local HTTP fixture verifies that model discovery, a test decision and normal agent execution use the stored credential without an environment variable.

Public anonymous deployments are tested for direct settings access without administrator registration, saved-key redaction, cross-origin write rejection and JSON requirements. Migration removes obsolete administrator credentials and setup-code files while preserving saved connections and legacy-import state. Existing whole-site Basic authentication remains covered separately.

Provider/model regressions additionally cover a shared credential across multiple enabled models, key rotation, enable/disable without losing IDs or options, atomic rollback of invalid selections, cross-provider edit rejection and provider deletion cascades. A flat SQLite fixture migrates OpenRouter Chat and native Decisions profiles into one provider while preserving their protocols, IDs and options. Catalog fixtures cover OpenAI and compatible/local endpoints, paginated Anthropic/Gemini/OpenRouter lists, native Decisions detection, non-text capabilities, repeated cursors and safe HTTP errors.

A Chromium workflow saves a provider key once, searches a 212-model catalog, enables multiple models, reloads, preserves the key, disables one model, runs a test decision, manually adds an ID and plays a one-turn match. The single/multiple dropdowns are searched and exercised with keyboard input. A 205-model mobile dropdown check verifies navigation beyond the initial rendered page without moving the document. Endpoint presets, Korean/mobile layout and light/dark rendered screenshots are checked. These requests use local protocol fixtures, not paid inference; adapter-wide live coverage remains limited to the connections documented above.

For deployments serving `dist/web` directly, the latest production build was validated in `.runtime/provider-build` with `vite build --outDir .runtime/provider-build/web`, `tsc -p tsconfig.server.json --outDir .runtime/provider-build/server` and `E2E_SERVER_COMMAND='node .runtime/provider-build/server/server/main.js' pnpm test:e2e`, alongside formatting, type checking and the full unit suite. This avoids exposing a new browser bundle to an older live server during validation.

On the deployed site, the upgrade preserved all four existing model IDs, credentials and per-model options under one OpenRouter connection. The live catalog returned 631 models, including 7 native Decisions models, without truncation. Public Chromium checks verified saved-model selection, catalog search, the arena dropdown and a 320px-wide viewport with no browser errors. This deployment verification did not make paid inference calls.

The arena and benchmark selectors now omit heuristic and seeded-random baselines, which remain available through the API/CLI. Chromium verifies registered-model defaults, provider-only benchmark options and the empty-model state, including disabling model matches and switching away from human play in decision mode. Arena play tests use a local provider fixture; no paid model is needed. Each test run uses an isolated settings database and results directory.

## Editable prompt experiments

Protocol tests compare the preview body with the actual request body for both native Decisions and Chat Completions. They verify replacement of all common prompt sections, per-model additions, legal-option preservation, sampling/token parameter serialization, raw overrides, nested Gemini output-schema preservation and credential redaction. Cloud previews also bypass credential-chain token acquisition without changing the normal Vertex endpoint. These fixtures do not measure strategy quality.

SQLite/API tests verify draft previews do not save edits, settings survive reopening the database, explicit run values override defaults, and a paired batch keeps its original prompts after settings change. Artifact version 2 saves editable prompts and redacted model parameters. Chromium exercises the attack preset, restoration as an unsaved draft, save/reload, per-model options, preview without inference, fixture inference, result metadata and 320/390px layouts in light/dark themes.

Protocol settings checks cover Decisions/LLM tabs with one selected model editor, a searchable picker, keyboard navigation, drafts retained across model/tab switches, saving one model without changing others, distinct serialized preview formats, save/reload and a Korean dark-theme layout at 320px. Default/reset checks verify the 1024-token limit and structured output, omission of empty sampling/token fields in serialized requests, and that resetting does not save automatically. Preview fixtures do not call external models.

## Benchmark tab

Replay navigation checks cover its dedicated tab and direct match URLs, empty/unavailable recordings, playback and seeking, pause-on-navigation with position retention, and isolation from arena/benchmark controls and live model selections. Reloading reopens the recording; English/Korean mobile layouts and dark mode are checked without additional inference calls.

Fixed-demo tests validate environment parsing, model-ID resolution, filtered model lists, rejection of settings writes and alternate inference routes, and enforcement of the same pair for arena and benchmark API requests. A browser fixture starts a separate server with `DEMO_MODELS`, verifies locked selectors and read-only prompt/model editors, checks saved-request previews and Korean mobile layouts, and never calls an external model.

Server tests cover the batch descriptor in `/api/state`, frozen execution settings, completion and cancellation, including preserving a past batch's status when a later arena match runs. Chromium runs a real local-fixture batch from the dedicated tab, verifies fixed decision mode with independent arena/benchmark limits and no time limit, restores active settings after reload, exits a historical replay through **Watch current match**, and checks all four paired results. It also tests empty-seed validation, cancelling both the current game and remaining schedule, and English/Korean light/dark layouts at 320, 390 and 640px. No paid model calls are required.

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
