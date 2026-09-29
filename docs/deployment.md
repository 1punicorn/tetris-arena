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

Choose authentication or explicitly opt into anonymous access. Startup fails if neither is configured for a public origin. Password protection covers all pages, APIs and SSE, even if the request uses a loopback Host header. The application validates exact Host/Origin. Top-level GET navigation from an external link is allowed; cross-site API fetches, embedded resources and POST requests remain blocked. Fetch Metadata headers are included in `Vary` so caches distinguish these requests. The application never trusts forwarded headers to grant access. A non-loopback connection must come from the configured proxy IP. Hostname aliases must not be rewritten to bypass these checks.

Configure DNS and your HTTPS proxy to forward the domain to `HOST:PORT`, preserving the original Host header. Disable buffering for `/api/events`, allow long-lived SSE and forward Authorization for Basic authentication. Use the proxy's real source IP, not a client IP from `X-Forwarded-For`. The proxy-to-app connection must be on a trusted private network or an encrypted tunnel. Do not expose that HTTP upstream directly to the internet.

## Model settings

`SETTINGS_DB` optionally overrides `data/settings.sqlite`. The service user needs write access to the database directory. Keep it outside the web asset directory and out of version control. Shared provider keys/endpoints, enabled models and model options are managed at `/#settings`, without editing `.env` or restarting the service.

To pin a public demo to two models, register them first and set `DEMO_MODELS=jev,deepseek/deepseek-v4.1-flash` in the server's `.env` or private `service.env`, then restart. Values are saved connection IDs or unique API model IDs. Startup rejects missing, disabled, unavailable, ambiguous or duplicate models. Demo mode makes all settings read-only and restricts both arena and benchmark requests to that pair, including API requests. Request previews remain available; alternate model tests and catalog discovery are blocked. Removing the variable and restarting restores normal settings without deleting data.

Settings opens directly without administrator registration or a setup code. If the entire site uses HTTP Basic authentication, that login also protects Settings. With `PUBLIC_ACCESS=true`, visitors can access the arena and manage model connections. Saved API keys are never returned to the browser.

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

To update the service after a source change:

```sh
pnpm install --frozen-lockfile
pnpm build
systemctl --user restart tetris.service
```

Verify HTTPS `/api/health` and the rendered page. A protected deployment returns 401 with a Basic challenge without credentials, and 200 after login. Confirm the model selector and live status connection, then use a short baseline match to verify start/finish without spending API credits. Wrong origins and hosts must still return 403. `pnpm dev` remains local by default; use another `PORT` when the service already owns 4317.
