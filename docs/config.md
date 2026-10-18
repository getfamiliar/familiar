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
6. **Publishes the agent settings.** The container fetches its passed config from the bastion at the start of every agentrun, so `inference.defaultModel`, `inference.aliases`, `inference.maxRetries`, `core.agentStepTimeout`, `core.timezone`, the tool knobs and the debug captures apply from the next run on. Runs in progress keep their snapshot.

### Restart-only keys

These keys are baked in at daemon start. A reload reports a change to them as "daemon restart required" and keeps the old value in effect (also for every reader of the config, so the daemon stays consistent) until `familiar stop && familiar start`:

| Key | Why |
| --- | --- |
| `core.postgresPassword` | Bound into the running postgres container and connections. |
| `core.bastionToken` | Shared by the running bastion, the agent container and the CLI token file. |
| `core.writablePaths` | Applied by the agent container's root entrypoint (file permissions). |
| `core.logRetentionDays` | Bound into the open log streams. |
| `python.packages` | Baked into the agent image. |

## Validation

- `familiar config lint` — structure, platform minimum, provider resolution, `python.packages` on PyPI.
- `familiar start` lints before it brings anything up and refuses to start on errors.
- Every write path (`familiar config set`, `familiar storage add|remove`, the agent's `config_*` tools) lints the result and restores the previous file on errors.
