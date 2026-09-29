# Tetris AI Bench

[![CI](https://github.com/hurxxxx/tetris/actions/workflows/ci.yml/badge.svg)](https://github.com/hurxxxx/tetris/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A local Tetris arena for comparing **decision models and LLMs** on the same assisted placement task. Watch AI vs AI, play against a model, or run paired, seeded evaluations from the command line.

- **Real-time matches:** gravity runs independently of asynchronous model requests.
- **Decision evaluation:** freeze gravity, collect both choices, then resolve both placements and attacks together. Model latency does not consume game time.
- **One provider interface:** OpenRouter Decisions, OpenAI-compatible servers, and official AI SDK adapters for OpenAI, Anthropic, Gemini, Azure, Bedrock and Vertex.
- **Local models:** connect Ollama, vLLM, LM Studio, llama.cpp or another compatible endpoint by URL. Compatibility depends on the server's API and selected model.
- **Inspectable results:** latency, invalid responses, retries, stale decisions, attacks, clears, tokens and reported cost; JSON/JSONL, CSV and replay.
- **No API key required to try it:** heuristic and seeded-random baselines are included.

English and Korean UI. Both boards stay visible on mobile. Model settings are stored in a local SQLite file using Node’s built-in driver; no separate database server, Python service or hosted account is required.

## Quick start

Requires **Node.js 24** and **pnpm 10.34.5**.

```sh
git clone https://github.com/hurxxxx/tetris.git
cd tetris
npm install -g pnpm@10.34.5
pnpm install --frozen-lockfile
pnpm dev
```

Open **http://127.0.0.1:4317**, then **Start match**. The default players are free local baselines. Starting a configured cloud model makes billable API calls using your credentials.

For a compiled build:

```sh
pnpm build
pnpm start
```

Run these commands from the repository directory. Settings are saved to `data/settings.sqlite`; results go to `results/`. No `.env` file is needed for local use. Optional `PORT`, `SETTINGS_DB` and `RESULTS_DIR` change these defaults. The server binds to loopback by default. For an HTTPS domain and a persistent service, see [deployment](docs/deployment.md).

## Connect models

Open **Settings** in the header:

1. Choose **Add provider**. Select OpenAI, Anthropic · Claude, Google · Gemini, OpenRouter, Ollama, vLLM, or a compatible/cloud provider.
2. Enter an API key once. Known providers have editable default API URLs; compatible services accept your own URL.
3. **Save & browse models** fetches the provider catalog. Search by name or ID, select the models you want, then **Apply models**.
4. If a provider does not list models, **Add a model ID manually** accepts a model or deployment ID. Apply it with the rest of your selections.
5. Return to the arena. Search inside either player dropdown by model or provider. The benchmark uses the same searchable picker with multiple selection (up to 12 models).

Only enabled provider models appear in these pickers. Human play and solo mode are available in the arena; heuristic and seeded-random baselines remain available through the API/CLI for experiments and automated validation. The arena defaults to the first two available registered models, or solo mode when only one is available. Model catalogs can include non-text models or models your account cannot run: known unsupported output types are disabled; a catalog entry is not a guarantee of inference access. Discovery supports paginated Anthropic, Gemini and OpenRouter catalogs. Up to 500 models can be stored per provider. Search covers the whole fetched catalog, including rows not yet displayed.

The **Connection** tab edits a shared key or endpoint for all models of that provider. Empty key fields preserve the stored key; a new value replaces it; **Remove saved key** explicitly deletes it. Keys are never returned to the browser. **Options** on a saved model controls its display name, reasoning, output format and provider options. **Test saved model** sends one real decision using saved options and may incur API charges. Saving settings and browsing catalogs do not perform inference.

No source edit, environment variable or restart is required. Deselecting a model keeps its saved ID and options for later re-enabling. Deleting a provider removes its saved models, while historical results remain. Changes apply to future matches; an in-progress match or paired batch keeps its initial configuration.

Settings opens directly with no administrator registration, password or setup code. It uses the same access policy as the arena: local access by default, the site login on a password-protected deployment, or anonymous access with `PUBLIC_ACCESS=true`. See [deployment](docs/deployment.md).

The SQLite file stores keys and connection details with owner-only file permissions; it is not encrypted at rest. Keep the database and its backups private. To back it up without a SQLite backup client, stop the server, copy `data/`, then restart. Do not copy only the main database while it is running because recent writes may be in its WAL file.

### Existing installations

On the first database initialization, `connections.local.json` (or `CONNECTIONS_FILE`) is imported once. Resolved `apiKeyEnv` credentials are copied into SQLite so those connections no longer depend on the environment. Missing credentials can be supplied in Settings. The old files are left intact; later edits use SQLite and deleted connections are not reimported. `connections.example.json` remains a legacy import/CLI example, not a required setup step.

The first start after upgrading a flat SQLite installation automatically groups models that share a provider endpoint and credential. Model IDs, reasoning/output options, saved keys and past results are preserved. Chat and native Decisions models can share one OpenRouter connection. Back up the database before upgrading; old server versions cannot use the normalized schema.

### Providers

| Profile `provider`     | API / credentials                                                              | Model inventory                   |
| ---------------------- | ------------------------------------------------------------------------------ | --------------------------------- |
| `openrouter-decisions` | OpenRouter native Decisions; saved API key                                     | Public Decisions catalog          |
| `openai-compatible`    | Chat Completions at your API base URL; optional saved key                      | `/models`                         |
| `openai`               | Official OpenAI Responses adapter; saved API key                               | `/models`                         |
| `anthropic`            | Official Messages adapter; saved API key                                       | `/models`                         |
| `google`               | Official Gemini adapter; saved API key                                         | `/models`                         |
| `azure`                | Official Azure OpenAI adapter; resource name, deployment ID, key               | Manual deployment ID              |
| `bedrock`              | Official Bedrock adapter; AWS region and credentials, or configured bearer key | Manual model/inference profile ID |
| `vertex`               | Official Vertex adapter; project, location and ADC, or configured API key      | Manual model ID                   |

The UI separates provider connections from enabled models. OpenRouter detects Chat versus native Decisions from catalog metadata; manual OpenRouter entries let you choose the protocol. OpenAI-compatible and Anthropic-compatible services have separate presets. Native OpenRouter Decisions uses the official endpoint; an OpenRouter URL override is supported for chat models only. Bedrock and Vertex accept saved API keys where supported; AWS IAM and Google Application Default Credentials remain optional server-managed alternatives. Region, project, location, Azure resource and API version can be edited in Settings. Cloud credential-chain readiness is checked when the provider is called, not inferred by the UI.

For **Ollama**, the preset uses `http://localhost:11434/v1`; for **vLLM**, the default URL is `http://localhost:8000/v1`. These addresses refer to the machine running the Node server, not the browser. Start and install models using the server's own documentation before running this tool. Neither server is installed automatically. LM Studio, llama.cpp, Groq, Together, Fireworks, DeepInfra and other services can use the compatible adapter when their endpoint implements the required Chat Completions contract. This is protocol support, not a claim that every service/model combination has been tested.

`providerOptions` uses the **official AI SDK namespace**: `compatible`, `openai`, `anthropic`, `google`, etc. For compatible servers, extra properties are forwarded through the SDK's documented provider-options extension. Ollama's `think: false` and vLLM's `chat_template_kwargs.enable_thinking: false` are model/server-specific; remove unsupported options or adjust them for your installed model/template.

Default output is a strict JSON schema containing exactly `{"choice":"option_N"}`. Set `"output": "json-text"` for a server without schema-constrained output. Its text must still be exact JSON matching that schema; prose, unknown IDs and extra fields are rejected. There is no JSON repair, hidden model fallback or engine-chosen substitute.

Newly enabled models use **provider-default** reasoning. Legacy profiles still default to **off**. When off is selected, confirm that the model supports it; the SDK receives `reasoning: "none"`; provider-specific flags can be configured where needed. Unsupported/compatibility warnings or reported reasoning output reject an off-mode result. A server may silently ignore flags and omit reasoning usage, so endpoint verification remains necessary. `on` requests the SDK's medium reasoning setting; `provider-default` leaves the provider's default intact. Do not mix these configurations in one claimed fair comparison.

## Benchmark

```sh
pnpm bench --config bench.example.json
# Alternative configuration/output directories:
pnpm bench --config bench.example.json --connections connections.local.json --out results/experiment-1
```

The CLI uses the same saved SQLite connections as the UI. `--connections` explicitly selects a legacy JSON file instead. The example benchmark runs heuristic vs random over five seeds with swapped sides: **10 matches**. Replace `models` with connection IDs from `/api/connections`, or select the models in the UI’s paired benchmark. Each pair is run in both seat orders for every seed. The UI's **Paired benchmark** uses the selected mode and optional limits shown above the arena. New pages default to real-time unlimited play; completed runs never replace a new visitor's mode or limits.

```json
{
  "models": ["jev", "kev", "solar"],
  "seeds": ["1", "2", "3", "4", "5"],
  "run": {
    "mode": "decision",
    "maxTurns": 500,
    "timeoutMs": 30000,
    "attempts": 3
  }
}
```

This example schedules **30 matches** and may make many paid calls. Matches have no time or turn limit by default and continue until top-out. The example config explicitly limits evaluation to 500 turns. Stop / Ctrl-C cancels active requests and remaining scheduled matches. A single request defaults to 30 seconds. A decision-evaluation turn retries up to three attempts, 500 ms apart, then marks the run failed. Real-time mode retries after 500 ms until top-out, cancellation or an explicitly configured time limit. SDK automatic retries are disabled.

Optional run limits: real-time 1–600 seconds; decision evaluation 1–2,000 turns. Omit them or set them to `null` for unlimited play; clear the limit field in the UI. Other settings: request timeout 100–120,000 ms; evaluation attempts 1–5. A decision turn can take the timeout multiplied by attempts and players; there is no separate wall-clock limit in decision mode.

Decision evaluation also shows movement and rotation before each landing, at 100 ms per input. Both choices are collected first, gravity stays frozen, and attacks still resolve after both placements. `decisionStepMs: 0` skips this visual pacing for fast headless batches; the example CLI config uses it. It does not change board outcomes or provider latency metrics.

### What the benchmark measures

This is **assisted spatial decision-making**, not a general-intelligence score. Every agent sees the same board representation, visible next piece, hold, opponent state, rules, strategy and up to 26 legal landing candidates. Candidate annotations include holes, height, roughness, attack, well geometry and up to four one-piece follow-ups. The model chooses the landing; deterministic engine code finds a legal path. Heuristic candidate pruning is part of the task and can affect rankings.

See [methodology](docs/methodology.md) for timing, fairness, game rules and artifact interpretation. Real-time scores combine decision quality and latency. Decision-evaluation scores remove gravity's latency penalty but still have timeouts. Report these modes separately. A model or transport failure is **failed**, not a loss; time/turn limits are draws, with no score tie-break.

## Results and replay

Every run writes a UUID directory under `results/`:

| File            | Contents                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `metadata.json` | Artifact/engine/policy versions, prompt hash, SDK/Node versions, selected profiles and option hashes |
| `summary.json`  | Seed, configuration, final boards, outcome and per-player metrics                                    |
| `events.jsonl`  | Timestamped state snapshots and sanitized decision/error events                                      |

CLI also writes `results.csv`. The UI exports a CSV of all finished runs in its configured result directory. Replay reads stored snapshots and makes no model requests. Replay is visual playback, not a second inference run.

Actual response model IDs are recorded when returned. Latency is reported separately for candidate preparation and the provider, with end-to-end last/p50/p95 for valid choices. Cost is **null** when unknown; LLM token counts are not converted using invented prices. Only provider-reported cost is accumulated. Keys, raw provider errors, reasoning text and raw prompts are not written to results. Prompt policy is public source; its hash and policy version identify it. Private endpoint URLs and provider-option contents are represented by hashes rather than exported verbatim.

## Architecture

```text
React UI ── local HTTP / SSE ── Hono coordinator
                                      ├── authoritative game clock
                                      ├── candidate worker pool
                                      ├── DecisionAgent interface
                                      │      ├── OpenRouter Decisions
                                      │      ├── official AI SDK adapters
                                      │      └── explicit baselines
                                      └── JSON / JSONL / CSV artifacts
CLI ────────────────────────── same coordinator
```

A small local server is deliberate: keys never enter the browser, local models avoid browser CORS problems, and tab throttling does not pause the game. Simulation and provider calls live in Node; candidate search runs in worker threads. It is an owner-operated tool, **not a multi-user hosted backend**. An explicitly configured HTTPS proxy can expose the shared arena with password protection or an operator-approved anonymous mode; see [deployment](docs/deployment.md). Only one match or benchmark runs at a time.

Source boundaries: `src/core` owns rules, observations and evaluation; `src/providers` owns validated profiles and adapters; `src/server` owns workers, local APIs and artifacts; `src/web` owns presentation. To add a provider, use its official AI SDK adapter or implement `DecisionAgent` and keep choice validation, cancellation, bounds and privacy guarantees. See [contributing](CONTRIBUTING.md).

## Validation

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

CI runs formatting, TypeScript checks, engine/fairness/provider/security/artifact tests, a production build and Chromium integration tests without API keys. See [verified capabilities](docs/validation.md) for what has and has not been exercised against a real service.

## License and origin

[MIT](LICENSE). Engine, placement search, assisted observations and strategy originated in the author's Open Work Hub Tetris app; see [NOTICE](NOTICE) for source attribution. This project runs independently and includes no OWH authentication, database, gateway, deployment configuration or credentials. It is not an official Tetris product.
