# Configuration (`config/config.yml`)

All host-side configuration lives in `config/config.yml` (gitignored; `config/config.example.yml` is the annotated sample). MCP servers have their own file, `config/mcp.yml` — see [`docs/mcp.md`](mcp.md). Both files stay on the host: the agent container never sees them, and credentials in them never reach the model.

## Structure

The file is a YAML mapping of top-level groups:

| Group | Owner | Content |
| --- | --- | --- |
| `core` | platform | Postgres password, default chat channel, bastion token, log retention, timezone, agent step timeout, tool knobs, `writablePaths`. |
| `inference` | platform | `defaultProvider`, `defaultModel`, `aliases`, `apiKeys.<provider>`, retries, context management, debug captures. |
| `mail` / `calendar` | platform | Cross-provider safety knobs (`allowSend`, `recipientWhitelist`, `allowAttendees`, `emitEventsInDev`). |
| `chat` | platform | `chat.compaction.thresholdBytes` / `keepUncompactedBytes`. |
| `storage` | platform | Cloud-storage mounts and policy (managed with `familiar storage …`). |
| `python` | platform | `python.packages` baked into the agent image. |
| `webserver` | platform | The user-facing web UI: `enabled`, `port`, `host`, `auth` (see [Webserver](#webserver)). |
| `<plugin-id>` | plugin | One group per plugin, named exactly like the plugin id (`telegram`, `ms365`, `memory`, `tesla`, …). |

The platform minimum (`core.postgresPassword`, `core.defaultChatChannel`, `inference.defaultProvider`, `inference.defaultModel`, `inference.apiKeys`) is checked by the linter; plugin groups are validated by their plugins. Unknown top-level groups are ignored.

## Key conventions

- **camelCase leaf keys**, dotted paths when referenced (`mail.allowSend`, `inference.apiKeys.openai`).
- **A plugin's own keys live under `<plugin-id>.*` only.** A config reload decides from this which plugins to restart: a change anywhere below `telegram` restarts the telegram plugin.
- **Foreign keys are read per use.** A plugin that needs a key outside its group (e.g. `inference.apiKeys.openai`) reads it through `ctx.config` when it needs it. If it has to capture the value in `prepare` / `start`, it lists the key in its manifest's `restartOnConfigChange`, so a reload restarts it when that key changes.
- **Secrets are recognized by name.** A path is secret when any of its segments contains `key`, `token`, `password` or `secret` (case-insensitive) — `inference.apiKeys.*`, `telegram.botToken`, `core.postgresPassword`, `core.bastionToken`. Secret values are masked whenever the agent reads the config (`"***set***"` when set, `null` when empty), and the agent cannot write them. Name new secret keys accordingly, and avoid these words in keys that are not secrets — a false positive only masks the value, a false negative would leak a credential into the model context.
- **No silent defaults in the file.** Leave a key out to get its default; defaults live in code at the read site.

## Editing

- **By hand.** Edit the file, then `familiar config lint` and `familiar config reload`.
- **`familiar config set <key> [value]`** writes one value, keeping comments. The value is parsed as YAML (`true`, `42`, `[a, b]`); omit it to be prompted. Secret keys are always prompted with hidden input (a value on the command line is refused, so it never lands in the shell history). The file is linted after the write and restored when invalid. Afterwards the command offers to reload the running daemon.
- **Through the agent** (privileged runs, tool group `config`):
  - `config_get({key?})` — the file as on disk (or one subtree), secrets masked; `pendingReload` lists keys that differ from what the daemon currently uses, `restartOnly` the keys that need a daemon restart.
  - `config_set({key, value})` — one non-secret value; refused for secret keys.
  - `config_unset({key})` — removes a key (and its subtree), so the default applies.
  - `config_reload()` — applies `config.yml` and `mcp.yml` (see below) and returns a report.
  - The `mcp_*` tools edit `mcp.yml` — see [`docs/mcp.md`](mcp.md#agent-tools).

  The edit tools only change the file; nothing takes effect before `config_reload`. Secrets have to be entered by the user (`familiar config set` or the editor) — the agent never sees or sets them.

## Reloading

`familiar config reload` (or the agent tool `config_reload`) applies both config files to the running daemon. There is no file watcher — a half-edited file is never picked up. A reload:

1. **Validates everything first**: the `config.yml` lint, provider resolution for every `inference.apiKeys` entry, the `mcp.yml` lint, and MCP-id clashes with plugin tool groups. On any error nothing is applied; the daemon keeps running on the previous configuration and the report lists the errors.
2. **Swaps the configuration.** Every host component that reads its value per use sees the new value immediately: mail / calendar safety, storage mounts and policy, `core.defaultChatChannel`, `core.timezone` (host side), chat compaction limits, the `llm-debug` retention, dev event gating.
3. **Rebuilds the inference provider table** of the LLM reverse proxy (`inference.apiKeys`, `inference.captureModelHttpRequestBodies`).
4. **Restarts affected plugins**: every plugin whose own group changed (or one of its declared `restartOnConfigChange` keys) is stopped, its tools / providers / prompt contributions are unregistered, and it runs `prepare` → `start` → `tools` again. A plugin that was disabled at boot (e.g. missing token) starts this way once its config is fixed. A plugin that has background work but no `stop` hook cannot be restarted in place and is reported as "daemon restart required".
5. **Applies the `mcp.yml` diff** — see [`docs/mcp.md`](mcp.md#reloading-mcpyml).
6. **Restarts the webserver** when a `webserver.*` key changed (stop, then start with the new settings — or stay stopped when `enabled` is now off).
7. **Publishes the agent settings.** The container fetches its passed config from the bastion at the start of every agentrun, so `inference.defaultModel`, `inference.aliases`, `inference.maxRetries`, `core.agentStepTimeout`, `core.timezone`, the tool knobs and the debug captures apply from the next run on. Runs in progress keep their snapshot.

### Restart-only keys

These keys are baked in at daemon start. A reload reports a change to them as "daemon restart required" and keeps the old value in effect (also for every reader of the config, so the daemon stays consistent) until `familiar stop && familiar start`:

| Key | Why |
| --- | --- |
| `core.postgresPassword` | Bound into the running postgres container and connections. |
| `core.bastionToken` | Shared by the running bastion, the agent container and the CLI token file. |
| `core.writablePaths` | Applied by the agent container's root entrypoint (file permissions). |
| `core.logRetentionDays` | Bound into the open log streams. |
| `python.packages` | Baked into the agent image. |

## Webserver

The daemon can serve a user-facing web UI. The core webserver handles authentication; the pages come from a web UI plugin — the `web-ui` plugin ([`plugins/web-ui/README.md`](../plugins/web-ui/README.md)). The web UI also renders the login pages (`/login`, the confirmation page of a login link, the "link not valid" page), while what they do stays in the core. Without a web UI plugin, the login pages are plain HTML and every other page is a plain notice saying who is signed in and that a web UI plugin such as `@getfamiliar/plugin-web-ui` should be installed. It is separate from the bastion on port 8788, which only serves the agent container and requires the bastion token.

| Key | Default | Meaning |
| --- | --- | --- |
| `webserver.enabled` | `false` | Start the webserver only when `true`. |
| `webserver.port` | `8080` | TCP port. Ports below 1024 fail with EACCES, because familiar never runs as root (the linter warns). |
| `webserver.host` | `0.0.0.0` | Bind address; `127.0.0.1` keeps it local to the machine. |
| `webserver.uiPlugin` | – | Id of the plugin whose web UI is served. Only needed when several plugins provide one; with a single provider it is picked automatically. A name that provides no UI shows a notice instead. |
| `webserver.lanUrls` | – | Base URLs (string or list) under which other devices reach the web UI directly, e.g. `http://my-pc:8080`. Login links are offered under them first. The agent adds an address here once you confirmed it works. |
| `webserver.auth.users` | – | **Required when enabled.** Logins allowed to use the web UI (a string or a list, compared case-insensitively), e.g. your Tailscale login. Without it the webserver does not start. |
| `webserver.auth.sessionDays` | `30` | Lifetime of a browser session created from a login link. |
| `webserver.auth.trustedProxies.<name>.userHeader` | – | Header in which a reverse proxy in front of the webserver passes the authenticated login (`Remote-User` for Authelia / Authentik, `X-Forwarded-Email` for oauth2-proxy). |
| `webserver.auth.trustedProxies.<name>.nameHeader` | – | Optional header with a display name. |
| `webserver.auth.trustedProxies.<name>.publicUrl` | – | Optional URL under which browsers reach the web UI through this proxy (e.g. `https://familiar.example.com`). |
| `webserver.auth.trustedProxies.<name>.hasBuiltInAuth` | `false` | `true` when the proxy signs users in by itself (e.g. Authelia's login page): its `publicUrl` is then offered as "signed in automatically", without a login link. With `false`, login links are built for it. |
| `webserver.auth.trustedProxies.<name>.secret` | – | Shared secret (at least 32 characters) the proxy sends as `X-Familiar-Proxy-Secret`. Set it with `familiar config set webserver.auth.trustedProxies.<name>.secret` (hidden prompt). |

A bind failure (port in use, privileged port) is logged and the daemon keeps running; fix the key and run `familiar config reload`.

### Who gets in

Every request needs an identity whose login is listed in `webserver.auth.users`. A known login that is not listed gets `403`; no identity at all gets a redirect to `/login` (browsers) or `401`. There are two ways to get an identity:

- **A trusted proxy vouches for it.** A request carrying `X-Familiar-Proxy-Secret` with the secret of a configured `trustedProxies` entry (or of a plugin that registered itself, such as the tailscale plugin; see [plugins/proxy-plugins.md](plugins/proxy-plugins.md)) is believed: the webserver reads that proxy's `userHeader`. A wrong secret gets `401`. Without the secret, identity headers like `Remote-User` or `Tailscale-User-Login` are **ignored**, so nobody who reaches port 8080 directly can forge them. Configure your proxy to set both headers and to strip any client-sent copies.
- **A session from a login link.** `familiar web login` (daemon running) prints a one-time link valid for 10 minutes; opening it and clicking *Sign in* sets an `HttpOnly` session cookie. `--user` picks the login (default: the first in `users`), `--url` the base URL to print (default `http://localhost:<port>`). The agent can create the same link with the privileged tool `web_login_link` (so only in runs from trusted input, such as your allowlisted chat) and send it to you; besides the link (under `webserver.lanUrls`, detected LAN addresses and `localhost`) it lists the URLs of proxies that sign you in by themselves (e.g. your tailnet URL), where no link is needed. The agent's instructions for this live in the workspace skill `skills/configuration/web-interface.md`. `familiar web sessions list` shows active sessions, `familiar web sessions revoke <id-prefix|all>` ends them. Removing a login from `users` also ends its sessions.

State-changing requests must come from the web UI's own origin (CSRF check on the `Origin` header). Over plain HTTP on your LAN, link and cookie travel unencrypted; prefer the tailnet (HTTPS) or a TLS-terminating proxy for access from other devices. To reach the web UI from your other devices without exposing anything else, use the optional tailscale plugin ([`plugins/tailscale/README.md`](../plugins/tailscale/README.md)).

## Validation

- `familiar config lint` — structure, platform minimum, provider resolution, `python.packages` on PyPI.
- `familiar start` lints before it brings anything up and refuses to start on errors.
- Every write path (`familiar config set`, `familiar storage add|remove`, the agent's `config_*` tools) lints the result and restores the previous file on errors.
