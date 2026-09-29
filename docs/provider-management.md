# Provider and model management

The UI follows a two-step flow: connect a provider once, then choose the models to expose in the arena. This keeps credentials and endpoint changes independent of per-model benchmark options.

## Design references

- [Open WebUI: OpenAI-compatible connections](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/) separates endpoint/key connections from fetched or manually listed model IDs.
- [LibreChat: custom endpoints](https://www.librechat.ai/docs/quick_start/custom_endpoints) supports multiple endpoints, fetching model lists and explicit default IDs. Our configuration lives in the Settings UI and SQLite rather than requiring YAML or environment edits.

Applied here: provider presets, editable URLs, one shared credential, optional discovery, manual fallback, an explicit enabled-model list, and search directly inside single- and multiple-selection dropdowns. The settings catalog is a flat list with search, selection filters and a persistent Apply action. Provider connection fields are on a separate tab; credentials do not repeat on each model.

## Discovery contracts

| Provider                 | Official reference                                                                                      | Behavior                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| OpenAI                   | [List models](https://developers.openai.com/api/reference/resources/models/methods/list)                | Bearer authentication, `/v1/models`; capability information is not guaranteed.                                     |
| Anthropic / Claude       | [List models](https://platform.claude.com/docs/en/api/models/list)                                      | API key and version headers; follow `has_more` / `last_id`.                                                        |
| Google / Gemini          | [Models API](https://ai.google.dev/api/models)                                                          | API key header; follow `nextPageToken`; use generation methods to identify text-generation support.                |
| OpenRouter               | [List models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) | Request all output modalities with limit/offset pagination, identify native Decisions models from output metadata. |
| Compatible / local       | Configured protocol                                                                                     | OpenAI `/models` or Anthropic Messages-compatible list API; manually add IDs if unsupported.                       |
| Azure / Bedrock / Vertex | Deployment-specific IDs                                                                                 | Manual registration; existing runtime adapters remain available.                                                   |

Catalog requests stay on the configured endpoint, block redirects, have bounded response sizes and a 30-second timeout, and stop at 10,000 models. Browsing never makes inference calls. Catalog access does not prove that an account can execute a model; the optional saved-model test makes one actual decision.

## Persistence

`providers` holds one endpoint/credential configuration per connection; `models` stores stable IDs, enabled state and benchmark options with a foreign key to its provider. Only enabled models are compiled into runtime profiles. The public selector API includes provider names but no secrets.

On upgrade, flat SQLite connections migrate in one transaction, grouping matching endpoints and credentials. Legacy JSON import remains one-time. Existing model IDs and options survive toggling and migration, so historical results retain their meaning. Model selection applies atomically: malformed or incompatible selections do not partially disable existing models.
