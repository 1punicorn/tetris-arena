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

English and Korean UI. Both boards stay visible on mobile. No database, Python service, Hermes or hosted account is required.

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

Run these commands from the repository directory. Configuration, `.env` and `results/` are resolved there. `PORT`, `CONNECTIONS_FILE` and `RESULTS_DIR` can override the local defaults. The server always binds to loopback.

## Connect models

```sh
cp connections.example.json connections.local.json
cp .env.example .env
```

Keep only the connection profiles you need. Put keys in `.env`, enter the correct model/deployment IDs, and restart the server after changing environment variables. **Reload connections** in the UI reloads the JSON file between runs.

For example, Jev and a local model:

```json
{
  "connections": [
    {
      "id": "jev",
      "name": "Jev",
      "provider": "openrouter-decisions",
      "model": "typesafe/jev-1.13",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    },
    {
      "id": "local",
      "name": "My local model",
      "provider": "openai-compatible",
      "baseURL": "http://127.0.0.1:11434/v1",
      "model": "YOUR_INSTALLED_MODEL",
      "reasoningOffSupported": true,
      "providerOptions": { "compatible": { "think": false } }
    }
  ]
}
```

Use `reasoningOffSupported: true` **only after verifying that the endpoint/model can disable reasoning**. The example file leaves this false for unverified LLMs. If a model cannot disable reasoning, explicitly choose `"reasoning": "provider-default"` or `"on"` and report it as a different configuration. Do not mark an unsupported model as compatible just to enable it.

A profile is a named participant. Duplicate a profile with another `id` to compare two models on the same provider. Within a profile, **Load models** discovers available IDs where supported; the model field also accepts a manual ID. The run records overrides. Changing a model requires rechecking its reasoning and structured-output capabilities.

### Providers

| Profile `provider`     | API / credentials                                                              | Model inventory                   |
| ---------------------- | ------------------------------------------------------------------------------ | --------------------------------- |
| `openrouter-decisions` | OpenRouter native Decisions; `OPENROUTER_API_KEY`                              | Public Decisions catalog          |
| `openai-compatible`    | Chat Completions at your `baseURL`; optional `apiKeyEnv`                       | `/models`                         |
| `openai`               | Official OpenAI Responses adapter; `OPENAI_API_KEY`                            | `/models`                         |
| `anthropic`            | Official Messages adapter; `ANTHROPIC_API_KEY`                                 | `/models`                         |
| `google`               | Official Gemini adapter; `GOOGLE_GENERATIVE_AI_API_KEY`                        | `/models`                         |
| `azure`                | Official Azure OpenAI adapter; resource name, deployment ID, key               | Manual deployment ID              |
| `bedrock`              | Official Bedrock adapter; AWS region and credentials, or configured bearer key | Manual model/inference profile ID |
| `vertex`               | Official Vertex adapter; project, location and ADC, or configured API key      | Manual model ID                   |

`connections.example.json` contains starter profiles. Bedrock uses the official SDK's AWS environment credentials; Vertex uses its official ADC integration. Empty `apiKeyEnv` references make a profile unavailable. Cloud credential-chain readiness is checked when the provider is called, not inferred by the UI.

For **Ollama**, use `http://127.0.0.1:11434/v1`; for **vLLM**, the usual URL is `http://127.0.0.1:8000/v1`. Start and install models using the server's own documentation before running this tool. Neither server is installed automatically. LM Studio, llama.cpp, Groq, Together, Fireworks, DeepInfra and other services can use the compatible adapter when their endpoint implements the required Chat Completions contract. This is protocol support, not a claim that every service/model combination has been tested.

`providerOptions` uses the **official AI SDK namespace**: `compatible`, `openai`, `anthropic`, `google`, etc. For compatible servers, extra properties are forwarded through the SDK's documented provider-options extension. Ollama's `think: false` and vLLM's `chat_template_kwargs.enable_thinking: false` are model/server-specific; remove unsupported options or adjust them for your installed model/template.

Default output is a strict JSON schema containing exactly `{"choice":"option_N"}`. Set `"output": "json-text"` for a server without schema-constrained output. Its text must still be exact JSON matching that schema; prose, unknown IDs and extra fields are rejected. There is no JSON repair, hidden model fallback or engine-chosen substitute.

Default reasoning is **off**. The SDK receives `reasoning: "none"`; provider-specific flags can be configured where needed. Unsupported/compatibility warnings or reported reasoning output reject an off-mode result. A server may silently ignore flags and omit reasoning usage, so endpoint verification remains necessary. `on` requests the SDK's medium reasoning setting; `provider-default` leaves the provider's default intact. Do not mix these configurations in one claimed fair comparison.

## Benchmark

```sh
pnpm bench --config bench.example.json
# Alternative configuration/output directories:
pnpm bench --config bench.example.json --connections connections.local.json --out results/experiment-1
```

The default benchmark runs heuristic vs random over five seeds with swapped sides: **10 matches**. Replace `models` with your profile IDs to use remote or local models. Each pair is run in both seat orders for every seed. The UI's **Paired benchmark** uses the selected mode and limits shown above the arena.

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

This example schedules **30 matches** and may make many paid calls. Each run is finite; Stop / Ctrl-C cancels active requests and remaining scheduled matches. A single request defaults to 30 seconds. A decision-evaluation turn retries up to three attempts, 500 ms apart, then marks the run failed. Real-time mode retries after 500 ms until top-out, cancellation or its time limit (default 180 seconds). SDK automatic retries are disabled.

Run limits: real-time 1–600 seconds; decision evaluation 1–2,000 turns; request timeout 100–120,000 ms; evaluation attempts 1–5. A decision turn can take the timeout multiplied by attempts and players; there is no separate wall-clock limit in decision mode.

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

A small local server is deliberate: keys never enter the browser, local models avoid browser CORS problems, and tab throttling does not pause the game. Simulation and provider calls live in Node; candidate search runs in worker threads. It is an owner-operated tool, **not a multi-user hosted backend**. Only one match or benchmark runs at a time.

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
