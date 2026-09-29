# Local execution boundary

This application is for one trusted local owner or one explicitly shared arena. By default it binds to `127.0.0.1`, validates Host/Origin and cross-site requests, and requires JSON for API writes. It does not implement separate hosted user accounts or per-user billing.

HTTPS deployment requires an explicit public origin and an access choice: password protection, or `PUBLIC_ACCESS=true` to deliberately allow anonymous model execution using server credentials. Non-loopback listening also requires a specific bind IP and a trusted proxy's actual socket IP. Forwarded headers never grant access. Use a trusted private proxy connection or an encrypted tunnel and a production build. See [deployment](docs/deployment.md).

Only owner-configured provider endpoints may make inference requests. HTTP is limited to local/private addresses; remote endpoints require HTTPS. Redirects are disabled. Requests/responses are bounded and inference has a configured timeout. Local configuration is trusted operator input; it is not a general-purpose SSRF proxy for untrusted users. Models return data only, never shell commands or executable code.

API keys are referenced by environment-variable name and read on the Node server. They are never supplied to the browser or persisted in run artifacts. Model/provider text is not inserted as HTML. Results may contain private model identifiers and game configuration; inspect artifacts before publishing them.

Use GitHub's private vulnerability reporting if enabled. Please do not include working credentials, private endpoint configuration or raw provider logs in public issues.
