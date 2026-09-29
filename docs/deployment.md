# Connect an HTTPS domain

The default remains loopback-only. A domain deployment is an explicit option for a single shared arena; it does not add separate user accounts, private matches or per-user billing.

## Configure the server

Use a production build (`pnpm build` then `pnpm start`), not the Vite development server. Set the following server environment variables:

| Setting                               | Meaning                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `PORT`                                | Listening port; default `4317`                                                                |
| `HOST`                                | A specific listening IP; default `127.0.0.1`. Wildcard addresses are rejected.                |
| `PUBLIC_ORIGIN`                       | Exact HTTPS origin, such as `https://arena.example.com`; no path                              |
| `TRUSTED_PROXY_IP`                    | Actual socket IP of the TLS reverse proxy; required for a non-loopback bind                   |
| `PUBLIC_USERNAME` / `PUBLIC_PASSWORD` | HTTP Basic login; use a unique random password of at least 16 characters                      |
| `PUBLIC_ACCESS=true`                  | Explicitly opts into anonymous access, including model execution billed to server credentials |

Choose authentication for a private full-featured instance, or explicitly opt into anonymous access with a configured demo pair. Startup fails if neither is configured for a public origin. Password protection covers all pages, APIs and SSE, even if the request uses a loopback Host header. The application validates exact Host/Origin. Top-level GET navigation from an external link is allowed; cross-site API fetches, embedded resources and POST requests remain blocked. Fetch Metadata headers are included in `Vary` so caches distinguish these requests. The application never trusts forwarded headers to grant access. A non-loopback connection must come from the configured proxy IP. Hostname aliases must not be rewritten to bypass these checks.

Configure DNS and your HTTPS proxy to forward the domain to `HOST:PORT`, preserving the original Host header. Disable buffering for `/api/events`, allow long-lived SSE and forward Authorization for Basic authentication. Use the proxy's real source IP, not a client IP from `X-Forwarded-For`. The proxy-to-app connection must be on a trusted private network or an encrypted tunnel. Do not expose that HTTP upstream directly to the internet.

## Model settings

`SETTINGS_DB` optionally overrides `data/settings.sqlite`. The service user needs write access to the database directory. Keep it outside the web asset directory and out of version control. Shared provider keys/endpoints, enabled models and model options are managed at `/#settings`, without editing `.env` or restarting the service.

To run a public demo, register the models locally first, then set `DEMO_MODELS=jev,deepseek/deepseek-v4.1-flash` in the private service environment and restart. Entries are saved connection IDs or unique API model IDs. Startup rejects missing, disabled, unavailable, ambiguous or duplicate models. Anonymous public access (`PUBLIC_ACCESS=true`) requires a valid pair, so accidentally removing `DEMO_MODELS` cannot expose unrestricted settings.

The demo uses the original Arena, Benchmark, Results, Replay and Settings screens in read-only mode. Visitors can inspect saved providers and their connection forms, search saved models, open model options, read prompts and generate saved-request previews without inference. Only the configured pair and their providers are visible. Provider API keys are omitted; nested credentials in advanced model parameters are redacted. Preview requests cannot override saved model or prompt settings.

Start Match starts one shared real-time match with a server-generated seed and saved model/prompt settings. Everyone sees the same match. No new match starts until it finishes and its recording has been saved. Pause, Stop, manual play, benchmark execution, settings writes, model tests and catalog discovery remain disabled in the UI and blocked by the server. The start endpoint accepts only an empty JSON object.

Completed recordings of the configured pair are retained across restarts. Results lists their start date/time in the viewer's local timezone, newest first; older recordings can be paged through. Legacy recordings without valid creation metadata fall back to the summary modification time. Replays make no model calls. Other models' recordings are not exposed, while read-only CSV and recorded prompt/option views remain available with credentials redacted. There are no daily usage quotas, automatic record deletions or additional match time limits. Manage spending at the API provider and monitor the results directory's disk usage.

Settings requires no administrator registration or setup code. Configure models before publishing, or stop the public service and open the same database from a local instance. Removing `DEMO_MODELS` restores the full tool only in local or authenticated private use. The optional whole-site HTTP Basic login still protects private deployments. Saved API keys are never returned to the browser.

An active match or batch retains its original profiles while Settings changes apply to future runs. The server and default CLI share the same SQLite file. Existing JSON profiles and resolved environment keys are imported once on initialization. Original files are retained for migration review; they are no longer the main settings store.

Upgrading a flat settings database migrates it to separate provider and model tables, grouping matching credentials/endpoints and preserving existing model IDs. Stop the old process before starting the new server; keep a pre-upgrade backup if you need to roll back to older code.

The database contains plaintext provider credentials protected by filesystem permissions. Back up the database securely using SQLite-aware tools, or stop the service before copying the whole database directory. Include WAL data if present; do not serve or publish these files.

## Keep it running with systemd

The repository includes a user-service template and a private environment-file template:

```sh
pnpm build
mkdir -p ~/.config/systemd/user ~/.config/tetris
cp ops/tetris.service.example ~/.config/systemd/user/tetris.service
cp ops/service.env.example ~/.config/tetris/service.env
chmod 600 ~/.config/tetris/service.env
```

Edit the service's `WorkingDirectory` and `ExecStart` for your checkout and absolute Node 24 binary (`command -v node`). Edit `service.env` with your bind IP, proxy IP, domain and access choice. Configure provider keys through the Settings screen; they persist in the private SQLite database. Do not commit the real service environment or print passwords in logs.

```sh
systemctl --user daemon-reload
systemctl --user enable --now tetris.service
systemctl --user is-active tetris.service
```

Enable user lingering with `sudo loginctl enable-linger "$USER"` if the service must start before login and keep running after logout. In a shell without a user bus environment, use `XDG_RUNTIME_DIR=/run/user/$(id -u)` for the `systemctl --user` command.

Before updating, wait for the shared match and recording to finish. Back up the private settings database and preserve the results directory. Build in a staging directory if the service is serving the current build. A normal offline update uses:

```sh
pnpm install --frozen-lockfile
pnpm build
systemctl --user restart tetris.service
```

Verify HTTPS `/api/health` and the rendered page. A protected deployment returns 401 with a Basic challenge without credentials, and 200 after login. For a demo, confirm the two fixed model names, all five navigation tabs and read-only Settings and `/api/state` readiness. Do not start a paid match just for a deployment check; use local fixture providers in the automated tests. For a private deployment, a short baseline match can verify start/finish without spending API credits. Wrong origins and hosts must still return 403. `pnpm dev` remains local by default; use another `PORT` when the service already owns 4317.
