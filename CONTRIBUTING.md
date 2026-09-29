# Contributing

Use Node 24 and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm format
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

Keep changes small and include tests for engine rules, provider protocols or evaluation behavior that change. CI uses baselines and local fixtures, never paid API credentials.

- Game rules and candidate generation belong in `src/core`, not a provider-specific prompt branch.
- Providers implement `DecisionAgent`; use official SDK adapters and extension points before adding custom transports.
- Every provider must accept the same `DecisionProblem`, honor cancellation, validate a choice from the offered IDs and report the actual model/usage when known.
- Preserve response/request size bounds, timeouts and sanitized error codes. Never log secrets, raw provider errors, raw prompts or reasoning text.
- Keep engine fallbacks explicit and named as baselines. Never silently replace an unsuccessful model decision.
- Changes to rules, candidate pruning or shared prompt content require a policy version change and updated methodology. Do not compare results from changed policies as if their task were identical.
- Add or update a provider entry in `docs/validation.md`, distinguishing protocol fixtures from a live service test.
- Update installation instructions when dependencies, config, environment variables or startup behavior change.

Before a PR, review `git diff` and ensure `.env`, `connections.local.json`, run artifacts and credentials are excluded. Source is MIT; contributions must be compatible with that license. The original engine attribution is in `NOTICE`.
