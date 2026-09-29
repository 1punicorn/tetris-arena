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

Choose authentication or explicitly opt into anonymous access. Startup fails if neither is configured for a public origin. Password protection covers all pages, APIs and SSE, even if the request uses a loopback Host header. The application validates exact Host/Origin. Top-level GET navigation from an external link is allowed; cross-site API fetches, embedded resources and POST requests remain blocked. Fetch Metadata headers are included in `Vary` so caches distinguish these requests. The application it never trusts forwarded headers to grant access. A non-loopback connection must come from the configured proxy IP. Hostname aliases must not be rewritten to bypass these checks.

Configure DNS and your HTTPS proxy to forward the domain to `HOST:PORT`, preserving the original Host header. Disable buffering for `/api/events`, allow long-lived SSE and forward Authorization for Basic authentication. Use the proxy's real source IP, not a client IP from `X-Forwarded-For`. The proxy-to-app connection must be on a trusted private network or an encrypted tunnel. Do not expose that HTTP upstream directly to the internet.

## Keep it running with systemd

The repository includes a user-service template and a private environment-file template:

```sh
pnpm build
mkdir -p ~/.config/systemd/user ~/.config/tetris
cp ops/tetris.service.example ~/.config/systemd/user/tetris.service
cp ops/service.env.example ~/.config/tetris/service.env
chmod 600 ~/.config/tetris/service.env
```

Edit the service's `WorkingDirectory` and `ExecStart` for your checkout and absolute Node 24 binary (`command -v node`). Edit `service.env` with your bind IP, proxy IP, domain and access choice. Keep provider keys in the checkout's ignored `.env`. Do not commit the real service environment or print passwords in logs.

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
