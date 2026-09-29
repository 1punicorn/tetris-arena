# Benchmark methodology

## Rules

- 10 columns × 20 rows, seeded 7-bag pieces and one visible next piece.
- One hold per piece; empty hold consumes the next piece. Unseen bag contents are never supplied to agents.
- Full rows clear on lock. Clearing 1 / 2 / 3 / 4 rows sends 0 / 1 / 2 / 3 garbage rows.
- Each garbage row has one independently seeded empty column. No attack cancellation, combo or back-to-back bonus.
- Top-out loses; simultaneous top-out draws. Score does not decide a duel.
- Rotation uses the extracted engine's horizontal offsets `[0,-1,1,-2,2]`, **not official SRS**. No official Guideline compliance is claimed.
- Gravity begins at 1 second per cell, decreases with level and bottoms out at 100 ms. A blocked downward tick locks immediately; there is no separate lock delay.

Both models receive the full locked board and active pose, next, hold, the opponent's visible state, rules and shared strategy. Policy `assisted-26-v2` prioritizes survival and safe line clears, including singles, doubles and triples using a held I. Holes or a maximum height of 8 trigger recovery instead of attack preparation; height 12 calls for urgent lowering. These are prompt guidelines, not engine-enforced rules. A safe clear may be deferred only for an explicit next-piece improvement in survival, or a larger clear while both resulting boards remain hole-free and below height 8. A four-row well is optional on a low, hole-free board when no useful clear is available; well readiness is not a reward for accumulating blocks. Both protocols use the same strategic content; the language-model protocol additionally requires the response JSON format. Results from v1's stronger Tetris-stacking preference are a different policy and should be reported separately.

## Assisted observations

The deterministic candidate builder enumerates reachable placements, keeps a safety/attack frontier and supplies up to 26 candidates, with seeded option-order shuffling. It provides current landing geometry, clears, attack, holes, maximum/aggregate height, roughness, key count and well depth/readiness/fill. The current self and opponent observations also include locked-board holes, height, aggregate height, roughness and wells, using the same measurements as the candidate outcomes. Up to four next-piece alternatives preserve safe and attacking follow-ups, with and without an available hold.

A model selects one offered landing. It does not emit arbitrary coordinates or optimize individual keypresses. The path executor then follows legal movement. Candidate filtering and lookahead reduce the agent's search burden: results measure choice quality **within that assisted candidate set**. A single offered candidate is a forced placement, counted separately without a model call. There is no hidden heuristic fallback after an invalid response.

## Fairness and reproducibility

The engine uses independent deterministic PRNG streams for pieces, garbage and option ordering. Both seats start with identical piece seeds. Garbage holes are seeded per sender independently of piece generation. A model's baseline random choices use a separate stream. Match scheduling pairs every model with every other model over the requested seeds, then reverses the seats.

In decision evaluation, both agents see immutable pre-turn snapshots. Calls are sequential to avoid competing for the same local GPU; after both answers are validated, legal movement/rotation frames are shown at `decisionStepMs` intervals (default 100 ms), then both attacks are applied after both placements. `decisionStepMs: 0` uses the identical input paths without visual pacing. The second model never sees the first model's answer or updated board. It may experience different provider load or warm-up, so paired runs reduce but cannot eliminate those effects.

In real-time, the server ticks continuously and executes one control input every 100 ms. An outstanding model call never blocks gravity. Each player has at most one inference request pending; new decisions are gated by a 250 ms minimum request interval. A target is retained only while the active piece and board remain valid; new pieces and garbage can make an answer stale. Stale valid answers are counted, not reused against another piece. Engine timing, operating-system scheduling and external provider variability make real-time runs **not bit-for-bit deterministic**.

Replaying a recorded run is deterministic snapshot playback. Repeating an evaluation reproduces board results when the agents choose the same options; cloud model nondeterminism, changing model aliases and provider routing remain outside the engine's control. Prefer pinned model IDs and keep your local profile/config alongside results. The artifact records the policy hash, options hash, endpoint hash, versions, seeds, explicit model overrides and reported actual model IDs; it does not export private endpoint/options contents.

## Failure policy

SDK retries are disabled; the runner alone owns retry timing.

| Mode                | On error, invalid JSON, unknown choice or timeout                                      |
| ------------------- | -------------------------------------------------------------------------------------- |
| Real-time           | Wait 500 ms and retry while the match is active; gravity continues.                    |
| Decision evaluation | Wait 500 ms, up to the configured attempt count (default 3), then mark the run failed. |

The 500 ms delay starts when the attempt fails; it is not a fixed request cadence. Retry time includes any new candidate search. Timeouts cover preparation plus inference. Cancellation aborts active inference. A candidate worker already performing CPU work finishes its bounded search and discards an aborted result; closing the coordinator terminates the worker pool.

A failed run is excluded from win/loss judgments. Real-time transport failures may still cause a genuine top-out while gravity continues; report the failure/timeout counts alongside that result. Cancellations are separate. Matches have no time/turn cap by default and continue until top-out. Explicit time/turn-limit finishes are draws. No hidden score or height tie-break is used.

## Metrics

- **Calls / valid / failures:** provider attempts, accepted responses and failures. Preparation failures can increment failures before a provider call.
- **Stale:** accepted responses that could not be applied because the piece/board/session changed.
- **Forced:** one-candidate placements, excluded from model decision counts.
- **Candidate / provider latency:** most recent preparation time and SDK/HTTP response time. Provider time includes transport, provider queue and output validation, not just inference.
- **Last / p50 / p95:** end-to-end successful choice latency, including candidate preparation; nearest-rank percentiles. Failed-request duration is stored in its event, not mixed into valid percentiles.
- **Placements / lines / Tetrises / sent:** engine results; CSV includes attack per placement. A four-line clear increments Tetrises.
- **Tokens:** provider-reported input/output/reasoning usage when available. Counts are accumulated for accepted responses.
- **Cost:** provider-reported cost only; null means unknown. A partial total is not a full billing estimate, especially when failed requests are billed.

Artifacts contain state snapshots (at most 10 Hz in real-time, plus transition events), not every simulation tick. Decision mode also records intermediate movement frames. JSONL replay shows those captured states; it is not a complete provider-request transcript. Do not infer a missing model explanation from the playback.

Compare win rate over completed paired runs, failure rate, survival, Tetris frequency, attack efficiency and latency together. Report mode, model ID, reasoning mode, assisted policy version and sample count. This task does not establish a model's general intelligence.
