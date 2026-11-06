# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Familiar is an AI executive assistant built as a containerized agent — your personal AI assistant: loyal, local, markdown. It observes the user's world (mail, calendar, chat, ticketing, etc.) and acts on the user's behalf — drafting, scheduling, summarizing, escalating — under explicit user approval for anything risky. The system is designed to be:

- **Proactive, not reactive.** It reacts to world events (incoming mail, calendar invitations, Jira webhooks), not just user prompts.
- **Personal.** The assistant's behavior is shaped by markdown files the user can edit. The "personality" lives in the workspace, not in code or model weights.
- **Extensible.** Plugins add capabilities (new event sources, new tools). Workflows let the user compose behavior without writing code.
- **Auditable.** Every decision and action leaves a trace. The user can read why something happened.
- **Safely sandboxed.** Reasoning runs in a container that cannot see credentials. The host injects auth into MCP calls via a reverse proxy.

Using open-weight models is the deliberate choice to keep costs predictable and be able to run the assistant on a flatrate basis.

# Architecture Overview

## Stack

- **TypeScript** end to end (host and container)
- **Docker** with a single agent container plus the Docker MCP Toolkit for tool aggregation
- **Postgres** for bus state (uses LISTEN/NOTIFY for event signaling)
- **Markdown** for all user-facing configuration, workflows, and the assistant's accumulated knowledge

Concerning LLM models, the system is flexible but opinionated towards:

- **Featherless.ai** as primary LLM provider (flat-rate, broad model selection); architecture is provider-agnostic so DeepSeek-API direct or Anthropic remain viable fallbacks
- **DeepSeek V4 Pro** for handlers that need heavy reasoning, **V4 Flash** for routing and lightweight handlers. Each handler chooses its own model.


## Top-level topology

The system splits into two trust zones: a **host** that holds credentials and orchestrates, and a **container** that does reasoning and tool use. They communicate only through data — the database and the MCP gateway. Neither calls functions on the other.

```
┌─────────────────────────────── HOST ────────────────────────────────┐
│  Plugin lifecycle, cronjobs, event sources, credentials,            │
│  MCP gateway (with auth injection), logging service,                │
│  approval gate UI                                                   │
│                                                                     │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐    │
│   │ Plugin host  │   │ Bus state DB │   │ MCP gateway / proxy  │    │
│   │   processes  │──>│  (Postgres)  │   │  (auth injection)    │    │
│   └──────────────┘   └──────────────┘   └──────────────────────┘    │
└─────────────────────────────────│──────────────────│────────────────┘
                                  │                  │
                          watches events &    all MCP calls
                          agentruns via       go through gateway
                          LISTEN/NOTIFY              │
                                  │                  │
┌─────────────────────────────── CONTAINER ───────────────────────────┐
│  Input-event watcher, agentrun scheduler                              │
│  Plugin container-side code mounted in (MCPs)                       │
│  Workspace (markdown files: handlers, workflows,                    │
│   people, projects, plugin-specific knowledge)                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Host responsibilities

- **Plugin lifecycle.** Plugins are npm packages. Each declares a manifest. The host loads them, runs their host-side code (event sources, daemons, cronjobs), and mounts their container-side code into the agent container.
- **Event ingestion.** Host-side plugin code produces events (incoming mails, Slack via socket, Jira via webhook, scheduled triggers, etc.) and writes them to the bus state database with idempotency checks.
- **Credential management.** OAuth tokens, API keys, and similar secrets live in the host. They are never passed to the container. The host refreshes tokens via cronjobs and injects them at call time through the MCP gateway.
- **MCP gateway.** All MCP servers are aggregated behind the Docker MCP Toolkit gateway. The container sees a single endpoint. Per-call authentication is injected by the gateway based on the calling agentrun's permissions.
- **Bastion authentication.** The host bastion (LLM reverse proxy, MCP gateway, plugin-tools and other gateways) binds on `0.0.0.0:8788`, so it is reachable from the LAN and from every container on `familiar-net`. To keep those callers out, `HttpServer` rejects any request without the shared `x-familiar-bastion-token` header with `401`, before any route runs. The agent receives the token through its passed config (`bastionToken`). The reverse proxy strips the header before forwarding upstream, and MCP containers never get it.
- **Approval gate.** When a handler proposes a write that requires user confirmation, it writes a pending action to the database. The host watches for these (LISTEN/NOTIFY), pushes a notification (Telegram, web UI, etc.), and writes the user's response back to the database.
- **Logging service.** Centralized structured logging endpoint. Container watchers, individual agentruns, and host plugins all log here with event + agentrun lineage for correlation.
- **Container lifecycle.** The host starts the container, mounts plugin container-side directories and sets up the containers network including the MCP gateway.

### Container responsibilities

The container runs a pull-based input watcher and an `AgentrunScheduler`:

- **Input-event watcher.** Watches the `events` table for new rows in `pending`, atomically claims them (`pending → running`), and inserts a root `agentruns` row for the event's topic (resolved to a workspace handler file, see "Handler resolution"). After that the input event is no longer of interest to the watcher; the event's terminal state mirrors the root agentrun's terminal state, set reactively when the root settles.
- **`AgentrunScheduler`.** Single in-process authority on which agentrun runs next. Holds an in-memory map of active runners (executing vs. paused), picks eligible `pending` rows preferring resume candidates, owns per-run timeouts and retry / failure classification, and is the *only* writer of agentrun lifecycle state. Concurrency is gated on the count of *executing* (non-paused) runners; the default `maxConcurrentExecuting=1` matches the single Featherless Pro slot. Per-model parallelism is a future filter on the same picker.

A handler can spawn **subagents** in two ways. A subagent is not needed to reach a tool — every tool is directly callable via dynamic discovery. Spawn one when you want isolation: a fresh/empty context and a different model or tool set (both taken from the target handler's frontmatter), and — in the future — parallel fan-out.

- `schedule_subagent({topic, prompt?, payload?, when?, key?})` — fire-and-forget, or an alarm. With a future `when` (ISO-8601 wall-clock in the user's local timezone), the host defers it and fires a fresh event at that time; pass a stable `key` to make rescheduling idempotent (re-using the key overwrites the previous schedule), or omit it for an auto-generated id. Without `when`, the new agentrun runs immediately as a child of the current run under the same event; the caller does not see its result. A `when` that parses to a past instant silently falls back to the immediate path. Companion tools: `unschedule_subagent({key})` cancels a pending schedule, `get_scheduled_subagents` lists them.
- `start_subagent({topic, prompt?, payload?})` — suspending. The current run is parked (state `waiting`) while the subagent executes; when it settles, the tool returns the subagent's final text as `resultText` (or its error if it failed) so the parent can react. The Scheduler genuinely frees the parent's execution slot during the wait — other agentruns can interleave.

`schedule_subagent` (immediate mode) and `start_subagent` children inherit `event_id` and `privileged` from the parent; `topic` is required and names the target handler exactly (`mail:analyze` → `mail/analyze.md`; the path form `mail/analyze.md` is accepted too). This produces an arbitrary, branching workflow tree rooted at the event's handler instead of a fixed pipeline. **The root agentrun is the orchestrator of its event**: the event's terminal state is the root's terminal state. Immediate `schedule_subagent` children are out-of-band side effects (they will not flip the event's outcome on their own — useful for fan-out fire-and-forget); `start_subagent` children fold their result back into the parent, so they participate in the root's outcome through the chain of returns. Deferred `schedule_subagent` wake-ups always run under a fresh event (no parent). The same suspend/resume mechanism will back the approval gate (see open question #1).

The container has no direct network access except through the MCP gateway. It has no credentials. It can read and write its workspace and the bus state database.

## Event flow

A canonical event lifecycle:

1. **Host plugin** detects something in the world (e.g. new mail via IMAP IDLE) and calls a standardized event ingestion API on the host.
2. **Host** writes the event to the `events` table with a globally unique idempotency key. Topic matches `[\w-]+(:[\w-]+)*` (e.g. `mail:new`, `chat:telegram:group:reaction`). `NOTIFY events_new` wakes the container.
3. **Container's input-event watcher** atomically claims the event (`pending → running`) and inserts a root `agentruns` row for it, with `topic` and `is_exact_topic` copied from the event. `NOTIFY agentruns_changed` wakes the agentrun scheduler.
4. **`AgentrunScheduler`** picks the row (`pending → running`), resolves the handler markdown file (see "Handler resolution"), and runs an agent session against it. The handler's content is the prompt; the agent has MCP tools plus the `schedule_subagent` / `start_subagent` subagent tools.
5. **Inside the handler**, the agent decides what to do next. It may call MCP tools, edit workspace files, and spawn subagents via `schedule_subagent` (fire-and-forget when called without `when`) or `start_subagent` (suspend-and-await) — e.g. `mail/index.md` triages, fans `mail:respond` off as a scheduled child, and starts `mail:analyze` to react to its summary. Each child is another `agentruns` row with `parent_agentrun_id` set to the spawning row, `event_id` propagated, and `calltype` set to `'scheduled'` or `'started'`. A `schedule_subagent` call with a future `when` produces no child agentrun under the current event — it inserts a `scheduled_subagents` row instead, and the host fires it later as a fresh event.
6. **For risky writes**, the handler proposes a **pending action** through the approval gate. The agentrun **suspends** until the user responds, then resumes and continues. Suspend/resume mechanics are TBD — see open questions.
7. **When the root agentrun finishes**, `AgentRunBus.settle()` writes its terminal state and, in the same transaction, mirrors that state onto the parent event via `EVENT_TERMINAL_UPDATE_SQL` (the event's outcome equals the root's outcome — root settles `done` → event `done`; root settles `failed` → event `failed`). Non-root agentruns settling out-of-band (scheduled `schedule_subagent` descendants) do not flip the event. `NOTIFY events_state` lets host plugins react to the final outcome (e.g. send a chat reply back to the user).
8. **Consequence events** (a write that triggers another world change) re-enter step 1 as fresh events with a new id. There is no global causation chain across events; lineage *within* an event lives on `agentruns.parent_agentrun_id`. Producers can pass parent context in the new event's payload if needed.

### Handler resolution

The topic is the handler's whole address — there is no separate handler basename. `:` separates folders and the last segment names the file: topic `chat:telegram` is `workspace/chat/telegram.md`, or its folder form `workspace/chat/telegram/index.md`. Only one of the two forms may exist; if both do, `x.md` wins and the run logs a conflict warning. Workspace-root files are never handlers, so a single-segment topic `mail` is only `mail/index.md`. The candidate list lives in `shared/src/HandlerResolution.ts` (`handlerCandidateLevels` / `resolveHandlerPath` / `topicFromHandlerPath` / `twinHandlerPath`), shared by the container's `HandlerFile.load` and the host's `HandlerCatalog`.

**Exactly one file is loaded** — nothing is merged or concatenated from less specific levels. Shared guidance goes into an included file (`{mail/rules.md}`) or a skill.

**Only world events fall back up the topic chain.** `events.is_exact_topic` / `NewEvent.isExactTopic` (default `false`) decides: for a non-exact event with topic `mail:new:ms365` the resolver tries `mail/new/ms365.md`, `mail/new/ms365/index.md`, then `mail/new.md`, `mail/new/index.md`, then `mail/index.md`, and runs the first file found. The root agentrun copies the flag (`agentruns.is_exact_topic`); everything that *addresses* a handler is exact and fails when the file is missing — `start_subagent` / `schedule_subagent` children (column default `true`) and deferred wake-ups, cron firings, cli-chat `/a/b/c` direct calls, the chat compactor and memory's `skills:memory:save`. Validation happens at subagent-spawn time: both subagent tools resolve the topic exactly and refuse if it doesn't exist, so the calling agent gets a synchronous error.

### Safety mechanisms

- **Tree-depth limit on agentrun lineage.** The `parent_agentrun_id` chain has a maximum depth (default 3, configurable). Past that, the subagent tools refuse to spawn and the user is notified. Prevents runaway loops.
- **Tool budget per agent invocation.** Each agentrun has a hard tool-call limit (default 15). Exceeding it terminates the run as `failed` and logs the failure. Protects against models that loop on weaker tool-calling adherence.

## Storage layers

Three distinct storage layers, each with a clear purpose and owner.

### 1. Bus state (host, transactional)

Postgres database, owned by the host. Both host and container access it via the shared `EventBus` / `AgentRunBus` clients in `shared/`. Two tables today:

- `events` — `id`, `topic` (CHECK against `TOPIC_PATTERN`, `[\w-]+(:[\w-]+)*`), `is_exact_topic`, `priority`, `state` (`pending|running|done|failed`), `payload`, `idempotency_key`, timestamps. Immutable record of "the world said this happened". State transitions are bookkeeping — nothing wakes on them except host-side completion waiters via `NOTIFY events_state`.
- `agentruns` — `id`, `event_id` (FK), `parent_agentrun_id` (self-FK, null for root), `topic`, `is_exact_topic`, `priority`, `state` (`pending|running|done|failed`), `prompt`, `payload`, `result`, `error`, timestamps. The assistant's response tree per event.

Three NOTIFY channels: `events_new` (INSERT into events; wakes the input-event watcher), `events_state` (state UPDATE on events; for host-side completion waiters), `agentruns_changed` (INSERT and state UPDATE on agentruns; wakes the agentrun scheduler).

Planned but not yet implemented: `pending_actions` (approval gate), `scheduled_triggers` (one-shot triggers from workflows, e.g. "30 min before this meeting"), `audit_log`.

### 2. Workspace (container, markdown)

Mounted directory, the assistant's process handbook, memory and personality. Structure:

```
workspace/
  PROMPT.md                 # the prompt template every handler renders (see "Prompt template")
  SOUL.md                   # the assistant's core identity and values, included by the default PROMPT.md as {SOUL.md}
  CONTEXT.md                # system-environment notes so the agent knows where and what it is, included as {CONTEXT.md}
  <topic>/                  # one folder per top-level topic (e.g. mail/, chat/, calendar/) - the user can invent new ones as needed, some are shipped by plugins
    index.md                # handler for topic `<topic>` (and fallback for unhandled `<topic>:*` events)
    analyze.md              # handler for topic `<topic>:analyze`, started by topic from another handler
    daily-digest.md         # example of a handler with "cron" (fires topic `<topic>:daily-digest`)
    <subtopic>.md           # handler for `<topic>:<subtopic>` — takes over from index.md for those events
    <subtopic>/             # folder form: `<subtopic>/index.md` is the same handler as `<subtopic>.md` (only one may exist)
      ...
  skills/                   # shared how-to recipes, referenced from handlers (see "Skills" below)
    <name>/
      SKILL.md
```

Handler files are plain markdown. They are usually authored by the user but can be created and modified by privileged event handlers.

#### Skills (shared recipes)

When the same domain knowledge is needed across multiple handlers (e.g. "how to create a Jira issue properly" used by both `mail/` and `chat/` handlers), put it in a skill instead of duplicating it. A skill is a single markdown file at `skills/<name>/SKILL.md`. The folder layout matches the [Agent Skills](https://agentskills.io/) convention so a skill can later ship bundled resources (templates, example payloads) without restructuring.

The file may start with optional `name` / `description` frontmatter for self-documentation:

```markdown
---
name: jira-issue
description: How to create a Jira issue (default project, due-date conventions, parent linking).
---

# How to create a Jira issue
...
```

Handlers reference skills by path in prose — there is no `load_skill` tool. Example: a handler can include *"Before creating a Jira issue, read `skills/jira-issue/SKILL.md` and follow it."* The agent reads it on demand with the existing `fs_read` tool, the same way handlers already pull in `people/<sender>.md` or topic-specific rule files.

Because models often skip that read, a handler can **preload** skills via its `skills:` frontmatter (`skills: jira, reflection, tesla`): `container/src/SkillFile.ts` loads each `skills/<id>/SKILL.md` (missing → `SkillNotFoundError`, the run fails) and `PromptBuilder` renders the bodies into the structural `{PRELOADED_SKILLS}` placeholder, one `# Skill \`<id>\` (preloaded)` section each, exempt from the per-file and (by their length) the system-prompt size caps. A skill's own `tools:` frontmatter is added to the handler's tool entries when it is preloaded (`combineToolEntries`; an omitted handler `tools` keeps its implicit `core`).

Skills grant no privileges — preloaded tools only save a discovery step, every tool is reachable via `tool_call` anyway and privilege is checked per call. A skill folder may also hold **handlers next to the recipe** — this is intended: e.g. the memory plugin's `skills/memory/save.md` runs for the exact topic `skills:memory:save`, and a `skills/memory/dream.md` with a `cron:` field would be scheduled like any other cronjob. `HandlerFile.load` and the `CronjobScheduler` treat `skills/` like any topic folder; only `HandlerCatalog.list` (cli-chat tab-completion) skips the subtree so the `SKILL.md` recipes don't clutter the proposals.

### 3. Configuration and secrets (host, YAML)

All configuration — sensitive and non-sensitive — lives in `config/config.yml` (gitignored; `config/config.example.yml` is the tracked sample). User-facing reference: `docs/config.md` — keep it in sync when key conventions, restart-only keys or the reload behavior change. The host accesses it via two services:

- **`ConfigService`** (interface in `shared/src/Config.ts`, implementation in
  `host/src/utils/ConfigService.ts`) is the runtime read/write surface. Plugin-agnostic; exposes
  `getString(key)` / `getNumber(key)` / `getArray(key)` keyed by dotted paths (e.g.
  `"core.postgresPassword"`, `"telegram.botToken"`), with optional defaults that widen the return
  type to include the default when omitted-vs-throws is the difference between "throw on missing"
  and "return null". Plugins reach it via `ctx.config`. **No plugin-specific types in `shared/`.**
- **`ConfigLinter`** (`host/src/utils/ConfigLinter.ts`) validates the file at boot: file readable,
  parses as a YAML mapping, contains the platform-level minimum (`core.postgresPassword`,
  `core.defaultChatChannel`, `inference.provider`, `inference.defaultModel`,
  `inference.apiKeys.<provider>`). Unknown top-level groups are ignored — plugins own their own
  keys, the platform doesn't enumerate them.

Top-level groups in `config/config.yml`:

- `core` — `postgresPassword`, `defaultChatChannel`, optional `logRetentionDays`. Required.
- `inference` — `provider`, `defaultModel`, `apiKeys.<provider>` map. Required.
- `mail` / `calendar` — cross-provider settings (send / attendee safety knobs). `emitEventsInDev` (default `false`) controls whether a dev instance (`FAMILIAR_DEV=1`) emits `mail:*` / `calendar:*` bus events; by default pollers still sync but the events are dropped (`host/src/utils/DevEventGate.ts`), so a dev instance sharing the production account doesn't replay its whole backlog. Production ignores the flag.
- `storage` — cloud-storage mounts and policy (`allowWrite`, `searchTimeoutMs`, `runQuotaMb`, `mounts.<alias>` with `plugin` / `account` / `drive` / `access` / `writeRoots` / `searchByDefault`). Parsed and statically linted by `host/src/storage/StorageConfig.ts` (also part of `config lint` and the daemon boot; plugin-aware checks run after `prepare`). Managed via `familiar storage list|add|remove|lint`; `add` / `remove` splice the file textually (`host/src/utils/ConfigDocument.ts`) so comments survive. Storage providers implement the `StorageProvider` SPI (`shared/src/Storage.ts`) and register via `ctx.storage.registerProvider` in **`prepare()`** (not `start()`) so the CLI reaches them without the daemon; the host `StorageService` owns refs, policy, search fan-out, cross-mount copy and the per-run byte quota, and the core `storage_*` tools are always registered — policy is enforced per call.
- `webserver` — `enabled` (default `false`), `port` (default `8080`), `host` (default `0.0.0.0`) for the user-facing web UI (see "Webserver").
- per-plugin (`telegram`, `whatsapp`, …) — owned by the plugin; plugin parses its own subtree and self-disables when absent.

Container-side config stays explicit: `buildAgentContainerConfig` (`host/src/container-bridge/ContainerConfig.ts`) hand-picks the values the container reads through `PassedConfig` — forwarded `config.yml` keys plus computed ones (`bastionUrl`, resolved providers, …). The map is passed as `FAMILIAR_CONTAINER_CONFIG` at container start and re-published after every config reload on the bastion's `/container-config/` endpoint (`ContainerConfigGateway`); the container fetches it at the start of every fresh agentrun (`refreshPassedConfig`) and overlays it, so container code must read settings per use, never into module-level constants. The real upstream API keys never enter the container; the reverse proxy injects them.

**Hot reload.** `DaemonReloader` (`host/src/reload/`) applies `config.yml` and `mcp.yml` to the running daemon, triggered by `familiar config reload` (bastion `POST /config-reload/`) or the privileged agent tool `config_reload` — never by a file watcher. It validates both files completely and aborts without changes on errors; then it swaps the `HostConfigService` state (restart-only keys — `RESTART_ONLY_CONFIG_KEYS`: postgres password, bastion token, `writablePaths`, log retention, `python.packages` — stay pinned and are reported), rebuilds the reverse-proxy provider table, restarts plugins whose `<plugin-id>.*` group (or a `restartOnConfigChange` key) changed via `PluginHost.reloadPluginsForConfigChange`, applies the `mcp.yml` diff (`McpRegistry.reload` → `McpGateway.applyDiff` → `PluginMcpService.invalidate`; the container's `McpClientPool.refreshIfChanged` reconnects ids whose catalog `generation` changed, once per agentrun), and publishes the container config. Host code must therefore read reloadable config per use (or accept a restart-only key); boot-time captures need an explicit apply step in the reloader.

**Agent config tools** (`host/src/config/`, core tools in group `config`, all `privileged` except `mcp_registry_search` / `mcp_registry_details`): `config_get` / `config_set` / `config_unset` / `config_reload` and `mcp_list` / `mcp_add` / `mcp_remove` / `mcp_set_env`; plus the read-only `mcp_registry_search` / `mcp_registry_details` (level `default`, same output as `familiar tools search-mcp` / `familiar tools mcp-details`, `host/src/mcp/registry-search/`: the search filters what our runtime can't run and rates provenance / publisher identity / popularity with 0–5 stars; details add settings, architecture hints, published tools and the repository's README / `.env.example` / Dockerfile, cleaned by `host/src/utils/ExternalTextSanitizer.ts`, long sections spilled to scratch). The editing tools edit the files (lint + rollback) and never apply anything themselves. `mcp_execute_bash_command` (privileged, `host/src/config/McpExecuteCommandTool.ts`) is the agent's `tools call-mcp`: it runs an MCP container one-shot with appended args; `McpCommandRunner` (`host/src/mcp/`) keeps a still-running command alive across tool calls (poll / stop by `callId`) and releases output only after `SecretOutputMasking` has masked every configured secret value. Secrets never pass through the agent: `isSecretConfigKey` (`host/src/config/SecretKeys.ts`) flags every path segment containing `key` / `token` / `password` / `secret`; reads mask such values, writes refuse them (the user enters them via `familiar config set` with a hidden prompt).

CLI: `familiar config lint` validates the file, `familiar config set <key> [value]` writes one value (secrets prompted hidden), `familiar config reload` applies both files to the running daemon. `familiar start` runs the linter implicitly before bringing the daemon up.

Note that `config/mcp.yml` contains the configuration for MCP tools and likely contains sensitive information like API keys as well.

## Webserver

`WebServer` (`host/src/web/WebServer.ts`) is the daemon's user-facing HTTP server, built on [Hono](https://hono.dev/) via `@hono/node-server`. It is deliberately separate from the bastion: the bastion is the token-gated gateway for the agent container, the webserver faces the user's browser and authenticates the user itself (see below). It starts after the plugin daemons when `webserver.enabled` is `true`; a bind failure is logged without taking the daemon down. `DaemonReloader` restarts it (`applyWebServer`) when a `webserver.*` key changed.

**Pages come from a web UI plugin.** A plugin's `webUi(ctx)` hook (`shared/src/Plugin.ts`, called after `start` like `tools`) returns a `WebUi` (`shared/src/WebAuth.ts`): a root `controller`, a `Hono<WebUiEnv>` app mounted at `/` after the auth middleware and the core login routes, so `c.get("principal")` is always set and `/login*` / `/logout` can't be shadowed, and optionally `renderAuthPage(view)`: the core's login routes (`mountLoginRoutes`, `host/src/web/auth/WebAuth.ts`) decide page, status and form actions, describe the page as a `WebAuthPageView` and only take the markup from the UI, served under `AUTH_PAGE_CSP` (no scripts, no external resources; fallback to the plain page when the renderer is missing or throws). `WebUiRegistry` (`host/src/web/WebUiRegistry.ts`) holds the controllers per plugin (dropped on plugin restart); `WebServer` rebuilds its app in place on every change (no socket rebind) and picks one via `webserver.uiPlugin` or the only provider. Without one it serves a plain-HTML notice to install a web UI plugin such as `web-ui`. **Menu items.** Any plugin can return a `WebMenuContribution` (`shared/src/WebMenu.ts`: `weight`, items with lucide `icon` id, `label`, optional `route`, optional `children` of label + route) from its `webMenu(ctx)` hook (after `start`, like `tools`). `WebMenuRegistry` (`host/src/web/WebMenuRegistry.ts`) validates them (malformed → plugin disabled in phase `webMenu`), drops them on plugin restart and lists them sorted by weight, then plugin id, for `ctx.web.listMenuItems()`. The web UI serves them in `GET /api/shell` (with the principal and `ctx.familiarVersion`), redirects `/` to `firstMenuRoute` (stays on the start page for an empty menu) and renders them with lucide's `DynamicIcon`. **Plugin pages and controllers.** A plugin's `webPlugin(ctx)` hook returns a `WebPluginUi` (`shared/src/WebPlugin.ts`): a Hono controller that `WebServer` mounts at `/plugins/<plugin-id>` (behind auth, after the login routes, before the UI root; concrete routes only, so the page's browser routes fall through to the web UI) and an optional page module (`MountWebPage` default export: `mount(container, context) → unmount`). Optional `sockets` (`WebPluginSocket`: `path`, `onConnection(peer, { principal, isHttps })`) are WebSocket endpoints at `/plugins/<plugin-id><path>`: `WebServer` serves them from the node server's `upgrade` event (they never reach Hono) with `ws` (`noServer`, 1 MiB frames), authenticates each handshake via `authenticateUpgrade` (`host/src/web/auth/WebAuth.ts`: same proxy/session/allowlist rules as the middleware, plus a **mandatory same-origin `Origin`** against cross-site WebSocket hijacking), hands plugins a library-independent `WebSocketPeer` (`host/src/web/WsPeer.ts`) and closes a plugin's sockets with 1012 when it re-registers. `WebPluginRegistry` (`host/src/web/WebPluginRegistry.ts`) holds them per plugin (dropped on restart, app rebuilt on change) and lists the pages for `ctx.web.listPages()`. The web UI passes them in `/api/shell`, loads the page owning the current route into its content area (`plugins/web-ui/src/components/plugin-page.tsx`), in dev mode from the plugin's `sourceFile` through its own Vite (`/@fs/…`, one React, Fast Refresh; a resolver maps `@/` to the importing package's `src/`). The `plugins/web-ui` plugin (React + Vite + Tailwind v4 + shadcn/ui; `src/components/ui/` is shadcn-generated and excluded from Biome via the plugin's nested `biome.json`, own components live in `src/components/`, host code in `src/host/`) serves `build/client` in production and renders the login pages server-side from the SSR bundle `build/ssr/render-auth-page.js` (`vite build --ssr`, fully bundled, CSS and fonts inlined); when `ctx.isDevMode` it runs Vite in middleware mode inside the daemon behind the core auth (HMR websocket on the first free loopback port from `127.0.0.1:24678`, so live reload works via localhost only) and renders the login pages via `ssrLoadModule`.

**Authentication** (`host/src/web/auth/`, user docs in `docs/config.md` → "Who gets in"): one middleware in front of every route derives a `WebPrincipal` and checks it against `webserver.auth.users`; an enabled webserver without users refuses to start (fail closed, also a linter error). Two sources only, no per-plugin special cases: (a) a **trusted proxy**, proven by the shared secret in `X-Familiar-Proxy-Secret` (`PROXY_SECRET_HEADER`, `shared/src/WebAuth.ts`), whose `userHeader` is then believed — entries come from `webserver.auth.trustedProxies.<name>` (`config:<name>`) and from plugins via `ctx.web.registerTrustedProxy` in `prepare()` (`plugin:<id>`, dropped on plugin restart), both in the `TrustedProxyRegistry`; without a matching secret, identity headers are ignored, so direct access to :8080 cannot forge them; (b) a **session** cookie from a one-time login link (`web_login_tokens` / `web_sessions`, hashes only; `familiar web sessions list|revoke`), minted by `familiar web login` or the privileged core tool `web_login_link` (`host/src/web/WebTools.ts`), both via `createLoginLink` (`host/src/web/auth/LoginLinks.ts`), which builds the link for `webserver.lanUrls`, a caller URL, proxies without built-in auth, detected LAN addresses (`HostAddresses.ts`, with WSL2 caveats) and `localhost`, and lists proxies with `hasBuiltInAuth` (tailscale) as plain auto-sign-in URLs. The agent's instructions for answering are the workspace skill `skills/configuration/web-interface.md`. Source-IP checks are deliberately not used (Docker Desktop NATs them). Non-GET requests need a same-origin `Origin`.

The optional `plugins/tailscale` publishes it in the user's tailnet: a `familiar-tailscale` docker sidecar (pinned `tailscale/tailscale` image) runs a dedicated node in userspace networking mode (entrypoint `tailscaled` directly — the image's `containerboot` aborts an interactive login after 60 s; the plugin drives `tailscale up` / `serve` via `docker exec` from a background monitor) whose only listener is `tailscale serve` HTTPS :443 → a pinned Caddy (`familiar-tailscale-proxy`, `--network container:familiar-tailscale`, bound to that namespace's `127.0.0.1:18080`) → `host.docker.internal:<webserver.port>`. Caddy adds the plugin's trusted-proxy secret, because `tailscale serve` cannot set custom headers (pattern for further such plugins: `docs/plugins/proxy-plugins.md`) — no TUN, no routes, DNS, SSH or advertisements, and no HTTP :80; the host itself never joins the tailnet. Docker helpers (`DockerTools`) and the webserver defaults live in `shared/` for this. **Web chat.** `plugins/web-chat` is the chat with the assistant on the chat channel `web` (feature parity with cli-chat: plain messages on `chat:web`, `/topic/sub …` direct handler calls with autocomplete, live agentrun/step/tool progress, proactive messages, failure messages, `/clear`, input history; plus scrollback and markdown). Files go both ways through the event's scratch folder: uploads (drag-and-drop on the chat, paste, paperclip; `multipart/form-data`) become `NewEvent.files` plus a hidden manifest `.web-chat-uploads.json`; every visible file in the folder is offered for download (`ctx.scratch.listFiles` / `resolveFile`, downloads as `attachment` + `nosniff` + sandbox CSP, raster images inline) — attachments at the user's message, the rest under the reply; the handler `chat/web.md` tells the model. Scratch convention: names starting with `.` are internal (`isHiddenScratchFile`, `shared/src/Scratch.ts`); spilled tool results use `scratchSpillFileName` (hidden + random suffix), so neither the prompt's staged-file list nor downloads show them. The page's stylesheet is scoped to its container with `@scope` (two Tailwind builds on one page would override each other) and the page renders no portals. Its `ChatHub` holds the single chat-bus subscription for the channel and fans it out to every browser tab over SSE (the bus marks a row delivered once, so tabs must not subscribe individually); history comes from `ctx.chat.listMessages`. The page is built from the shadcn chatbot template's primitives (`message`, `message-scroller`, `bubble`, `trace`, `input-group`, `code-block`, typeset).

**Voice.** `plugins/gpt-voice` (menu "Voice") places voice calls with OpenAI's full-duplex GPT-Live (`gpt-live-1`, $0.05/min); it needs `inference.apiKeys.openai` (read per call) and a secure context for the microphone, and the page shows what is missing otherwise. The page runs the AI SDK 7 `Experimental_AbstractRealtimeSession` with the Live codec in relay mode over the plugin socket; the host (`LiveUpstream`, `ws` + `getServerWebSocketConfig`) holds the key, ignores the page's `session.start` settings, starts the session from `workspace/voice/live.md` (frontmatter `model` / `voice`, body rendered with the shared `PromptTemplate` so `{SOUL.md}` works; not a handler despite its folder) with `delegation: { type: "client" }`, and relays only audio/mute frames from the page. GPT-Live's `session.delegation.created` carries only an id, so `DelegationBroker` emits `voice:background` (exact, `privileged`, channel `voice`) with the recent transcript as the prompt (`voice/background.md` holds the policy) and sends the result back via `context-append` → `session.commentary.append` for that delegation id, which the model speaks; `send_chat` progress on channel `voice` is routed to the call too, and a result arriving after hang-up goes to `core.defaultChatChannel`. `CallTranscript` assembles transcript fragments into turns (per speaker, 1.5 s audio pause) and `ChatRecorder` writes them via `ctx.chat.appendMessage` under a record-only `voice:call` event emitted with `state: "done"`. The call core (`src/host/live/`, `LiveCall` + `CallTransport`) is transport-independent so a phone transport (OpenAI SIP + sideband attach, G.711) can be added later.

## Plugins

Plugins are npm packages with a standard structure:

```
my-plugin/
  package.json              # with manifest under `assistant` field
  host/                     # runs in host process
    index.ts                # event sources, cronjobs, daemons
  container/                # mounted into container
    mcps/                   # plugin-provided MCP servers (optional)
  workspace-template/       # copied into workspace on first install
    <topic>/
      index.md
      ...
```

A plugin may emit events on any number of topics and usually ships default handlers for the emitted events in its folder under `workspace-template/`. The daemon checks all workspace templates on startup and copies new / missing files to the `workspace/` directory.

### Plugin manifest (in package.json)

Declares:

- Plugin id (`[a-z0-9-]+`), version
- MCPs required (with required scopes)
- MCPs provided (optional)
- Cronjobs and daemons (with schedule and entry points)

### Emitted event topics

Topics are not declared in the manifest but in code: a plugin's `getEmittedEvents(ctx)` hook (`shared/src/Plugin.ts`) returns the topics it emits *under the current config* (`{topic, description, isExactTopic?}`) — e.g. ms365 omits `mail:new:ms365` when its mail poller is off. The hook is synchronous and side-effect-free like `tools()`; `PluginHost.listEmittedEvents()` collects it after `prepare`. Host-emitted topics live in `CORE_EMITTED_EVENTS` (`host/src/events/CoreEmittedEvents.ts`). `familiar events list-topics` lists core, plugin and cron topics with the handler file each resolves to (works without the daemon).

## Cronjobs

Any handler can declare a `cron:` field in its YAML frontmatter. The host's
`CronjobScheduler` (in `host/src/cron/`) scans the workspace at daemon startup, watches for
file changes via the generalized `WorkspaceWatcher` (in `host/src/utils/`), and
registers a Croner job per valid expression. When the cron fires, the scheduler emits a fresh exact-topic event whose `topic` is derived from the file's path (`mail/digest.md` → `mail:digest`, `mail/digest/index.md` → `mail:digest`), with the prompt `"The cronjob has fired"` and no payload. A folder-form `x/index.md` whose twin `x.md` exists is shadowed, so its firing is skipped with a warning.

The expression is parsed by `friendly-node-cron` first (`every monday at 8 am`,
`every 5 minutes`, `weekly`, …). If the friendly grammar doesn't match, the verbatim string
is passed straight to Croner as a raw cron expression. Invalid expressions are logged at
`warn` and silently dropped; the rest of the workspace keeps working. Editing or deleting
a handler file re-evaluates its job live — no daemon restart needed.

`familiar events list-crons` prints every handler with a `cron:` field, the verbatim string, and the
parsed expression. The command runs a standalone filesystem scan, so it works whether the
daemon is up or not.

Example: `workspace/emails/monday-digest.md` (fires topic `emails:monday-digest`)

```markdown
---
cron: every monday at 8
---
# Send a week-ahead briefing via Telegram

Compile a briefing of calendar events, open tasks with deadlines this week, and unread
mails marked important. Send the briefing via Telegram.
```

**Handler placement rule:** handler markdown files must live under at least one topic folder (e.g. `workflows/<name>.md`, `mail/digest.md`), and every path segment must be a valid topic word (`[\w-]+`, so no dots or spaces in file names).

### Editing handlers via chat

When the user asks for it in the chat, the agent can edit the handler markdown files to reflect the requested behaviors.

## Markdown layers and self-organization

Handler behavior is shaped by markdown files in layers, each with distinct ownership and purpose:

- **Code-level capability** — what plugins make possible (in TypeScript/MCPs)
- **Prompt template** — `PROMPT.md`, the single file defining how a handler's prompt is assembled; it pulls in `SOUL.md` and `CONTEXT.md` (identity and situational context, written by the user) via `{SOUL.md}` / `{CONTEXT.md}` includes
- **Handler layer** — one handler file per topic (`<topic>/index.md`, `<topic>/analyze.md`, `<topic>/<subtopic>.md`, …); the most specific file for an event's topic runs alone. Plugin-shipped defaults, user-editable.
- **Knowledge layer** — facts about people, projects, etc. (`people/`, plugin-specific), built up over time by handlers themselves, correctable by the user

Handler prompts are kept short. They tell the agent how to find more context (e.g. "always read `people/<sender>.md` before drafting a reply"). The agent pulls additional files into context as needed. This avoids loading large amounts of context into every prompt and lets the assistant build its own knowledge structure over time, guided by user conventions.

### Prompt template

All prompt prose lives in the workspace, not in code (user-facing reference: `docs/prompting.md` — keep it in sync when placeholders or frontmatter fields change). `buildPromptParts` (`container/src/PromptBuilder.ts`) renders the template a handler selects via its `systemPrompt` frontmatter: `default` (or absent) → workspace-root `PROMPT.md`, `none` → the handler body alone, `<path.md>` → that workspace-relative template. A missing template fails the run with a clear error; there is no built-in fallback.

Template syntax (`shared/src/PromptTemplate.ts`, also used by host plugins such as `gpt-voice`):

- `{NAME}` (`[A-Z][A-Z0-9_]*`) is a placeholder; `{path.md}` includes a workspace-relative markdown file (no `..`). Other braces — JSON examples, `{lowercase}` — stay untouched.
- Only workspace markdown is template: `PROMPT.md`, files it includes, and `{HANDLER_CONTENT}` (the handler body) are expanded recursively (depth ≤ 3, cycles stopped). Values produced by code or plugins are inserted verbatim and never rescanned, so event content containing `{SOUL.md}` cannot pull files into the prompt.
- Problems never fail the run: unknown placeholders stay verbatim, missing includes render empty, bad paths/cycles keep the token — each with a `prompt template: …` warning in the agentrun log.
- List placeholders render `(none)` when empty; templates have no conditionals.

**Cache split.** The first `{CACHE_MARKER}` in the template splits it: everything before it is the system prompt — *static per handler*, so it forms a cacheable prefix (provider caches are prefix caches: DeepSeek/OpenAI automatically, Anthropic via breakpoints). Everything after it leads the current-run **user message**, followed by plugin appender sections. In multi-turn chat this keeps the prior history a stable, cacheable prefix while the fresh runtime info attaches to the trailing turn. Placeholders are `static` or `dynamic` (per run); a dynamic one before the marker produces a warning.

Core placeholders are defined (name, description, kind) in `CORE_PROMPT_PLACEHOLDERS` (`shared/src/PromptPlaceholders.ts`) and resolved by `CORE_PLACEHOLDER_RESOLVERS` (`container/src/prompt/CorePlaceholders.ts`). Plugins extend the prompt two ways, both served to the container by the bastion's `PromptGateway`:

- `ctx.prompt.registerPlaceholder({name, description, provide})` — a named, per-run placeholder (`/prompt-placeholders/`, only names a template uses are resolved). Register in `prepare()` so the CLI sees it; colliding or malformed names throw `PromptPlaceholderConflictError`.
- `ctx.prompt.registerPromptAppender(fn)` — free text appended to the user-message head (`/prompt-appenders/`), e.g. the memory plugin's `# Memories` table.

CLI: `familiar prompt placeholders` lists every placeholder (works without the daemon). `familiar prompt dry-run <topic> [--privileged] [--prompt] [--full]` renders a handler's prompt inside the running agent container (`docker exec` → `container/src/prompt/PromptDryRun.ts`) with the real tool set and plugin values, without inserting an agentrun or calling a model.

## Lifecycle and operations

### Plugin lifecycle

- **Cronjobs** — stateless, idempotent. On exception: log and continue at next schedule. Use `node-cron` or `bullmq`.
- **Daemons** (long-running processes like IMAP IDLE, Telegram bot) — exponential backoff on restart (1s → 2s → 4s → ... up to 5min cap).
- **Graceful shutdown** — SIGTERM with 10s grace period; plugins should drain in-flight operations and persist any pending state.
- **Failure isolation** — a plugin whose `prepare`, `start` or `tools` hook throws is logged and disabled instead of taking the daemon down (`PluginHost.failedPlugins`); a summary line lists every disabled plugin at boot. Its tools stay registered but every call fails with the original error, and its own CLI commands rethrow a `prepare` failure. After fixing the cause in its config group, `familiar config reload` restarts the plugin (or restart the daemon) — there is no automatic retry.
- **Restart on config reload** — a plugin can be restarted in-process: `stop` → unregister its tools, mail / calendar / storage providers and prompt appenders / placeholders → `prepare` → `start` → `tools`. So `stop` must release everything `start` set up (timers, poll loops, sockets, chat / workspace subscriptions) and reset module state. A plugin with a `start` but no `stop` is reported as "daemon restart required" instead. Foreign config keys captured in `prepare` / `start` go into the manifest's `restartOnConfigChange`.
- **Never as root** — the CLI refuses to run with uid 0: a root run leaves root-owned files under `data/` that the next normal start can't read.

### Logging

All components log using a centralized logging service. Fields include plugin id, severity, timestamp, lineage (event id + agentrun id + parent agentrun id), message, structured context. The host persists with rotation. Logs can be correlated across host plugins, container watchers, and individual agentruns.

## Concurrency and model usage

Each handler's markdown file declares which model the agent runs under. Instead of a concrete model ref, a handler may name a key from `inference.aliases` in `config.yml` (e.g. `model: fast`); `ModelFactory` resolves it (single level, `defaultModel` may be an alias too) and `agentruns.model` records the resolved `<provider>/<modelId>`. The heavy model (V4 Pro) is the bottleneck: Featherless's premium tier exposes one concurrent slot for 70B+ models.

To keep things simple for now:

- The agentrun scheduler processes **one agentrun at a time**, FIFO within priority. Priority is inherited from the parent event (set by the host plugin that ingested the event).
- Lightweight handlers (V4 Flash) currently share the same single-slot watcher. Per-model concurrency limits — letting Flash handlers run in parallel with one heavy handler — are deferred until the bottleneck actually bites.

The provider boundary is abstracted. The model client interface allows swapping Featherless, DeepSeek-API direct, Anthropic, etc., without changes to handler code or watcher logic. This is important both for cost control and for long-term resilience as open-weight models evolve.

**Inference error policy.** Retryable `APICallError`s (408/429/5xx — including Featherless's `503 "Model is over capacity"`) do not block the watcher slot. `AgentRunner` postpones the row by writing it back to `pending` with a future `not_before` and bumping `retry_count`; the watcher claims it again when the time arrives, and other agentruns (potentially using different models) can run in the meantime. Delay is taken from `retry-after[-ms]` headers when present and reasonable, else exponential backoff (2s → 4s → … capped at 15 min). The cap counts retries after the first attempt and defaults to 10 (`inference.maxRetries` in `config.yml`), which spans roughly half an hour of backoff — enough to ride out a provider outage (e.g. `504 Gateway Timeout`) without losing a cron run. It can be overridden per-handler via a `maxRetries` field in YAML frontmatter (set to 0 there to disable retries for one handler). Non-retryable errors (404 wrong model id, 401 bad key, 400 bad request) fail fast with a `formatInferenceError`-rendered message on `agentruns.error` ("The model API answered with 404 Not Found at https://… — <body excerpt>"). The Vercel AI SDK's own `maxRetries` is set to 0 so it doesn't block inside `agent.generate()`; we own the retry loop.

## Approval gate

For any action classified as risky (configurable per tool, declared in the plugin manifest):

- The handler writes a `pending_action` row, taking resource locks as needed. The agentrun **suspends** — its row stays in `running`, but the agent loop is parked waiting on user response. (See open questions for the exact suspend/resume mechanics.)
- The host's approval service watches for new pending actions (LISTEN/NOTIFY), pushes a notification with action details, accepts user response (approve / modify / reject) via Telegram, web UI, or other configured channel.
- On approve: the agentrun resumes, executes the write via MCP, releases locks.
- On reject or timeout: the agentrun resumes, sees the rejection, and continues (or terminates as `failed`) accordingly.
- Compound actions (multiple writes that must commit together) share a `compound_id` and are presented as one approval request.

Risk classification levels:

- **Autonomous** — execute without approval (e.g. mark mail as read, archive obvious newsletter).
- **Notify-on-default-approve** — proposed with a short timeout (e.g. 5 min) after which auto-approve unless rejected.
- **Approval-required** — must be explicitly approved.

## Open questions for implementation

The following are deliberately deferred but should be addressed during implementation:

1. **Suspend/resume mechanics for agentruns awaiting user feedback.** When a handler proposes a pending action — or otherwise asks the user a question — the agentrun has to wait for a response that may take seconds or hours. Does the watcher slot stay parked on the suspended agentrun (simple but burns the single slot for the duration), or does the agentrun get persisted to disk and re-scheduled when the response lands (requires re-hydrating agent + tool state)? Same question for general user-feedback prompts, not just approval gates.
2. **A successor to the old "rules" concept.** Earlier designs had user-authored event-driven rules (`workspace/<plugin>/rules/`) with a two-stage retrieval helper. That mechanism is dropped for now — handler files cover the same surface less directly. Some way for the user to add cross-cutting reactive behavior without editing a topic's handler is still wanted; shape TBD.
3. **Per-model concurrency limits.** The agentrun scheduler is single-slot today. Letting lightweight handlers run in parallel with one heavy handler is straightforward (model column on `agentruns`, watcher claim filter), but only worth the complexity once the single slot is actually a bottleneck.
4. **Diff/merge on plugin updates** — when a plugin update brings new defaults but the user has customized their copy, present a diff and let the user choose. Even better: let the LLM handle the merge in a guided dialogue.
5. **Web UI for workspace inspection and audit log browsing** — useful for debugging and understanding system behavior.
6. **Eval harness** — a way to replay events against the system and measure handler quality. Critical for confidently swapping models or tuning prompts.

## Implementation order suggestion

1. **Bus state schema and access** — done: `events` and `agentruns` tables, `EventBus` and `AgentRunBus` clients in `shared/`, reactive event-terminal logic via `EVENT_TERMINAL_UPDATE_SQL`.
2. **Container watchers** — input-event watcher (events `pending → running`, spawns root agentrun) and agentrun scheduler (agentruns `pending → running → done|failed`, runs handler markdown via the agent runner). The current `TriageWatcher.ts` is a stub for the input-event watcher; replace it next.
3. **Handler resolution + subagent tools** — workspace path resolver with sub-topic override fallback, plus the in-handler `schedule_subagent` (fire-and-forget when called without `when`, deferred fresh-event when called with one) and `start_subagent` (suspending) tools that spawn child agentruns by topic and validate at spawn time.
4. **Plugin loader and lifecycle** — host-side plugin loading, manifest parsing, container mount of `mcps/`, `workspace-template/` copy on first install.
5. **Logging service** — centralized structured logging.
6. **Approval gate** — `pending_actions` table, suspend/resume mechanics (per the open question above), notification push (start with Telegram or simple web UI), response handling.
7. **First real plugin** — ms365 plugin end to end as the reference implementation: msal-node device-code login in the host, `mail/index.md` (and optionally `mail/new/ms365.md`) handlers in the workspace, direct Microsoft Graph calls from host-side plugin tools.
8. **Cron scheduler** — host-side scanning of handler frontmatter for `cron:` fields,
   live re-evaluation on file change, event emission on firing. *(Implemented:
   `host/src/cron/`, `host/src/utils/WorkspaceWatcher.ts`.)*
9. **Additional plugins** — calendar, Jira, Telegram, chat (probably web UI for chat).

## Design principles to preserve

When in doubt during implementation:

- **Pull, don't push.** Container pulls work from the database. Host writes events, but does not invoke functions in the container.
- **Markdown is the user-facing API.** If the user needs to configure or extend something, the answer is a markdown file in the workspace, not a config schema or UI form (unless it's about presenting markdown).
- **Capability vs. policy separation.** Plugins ship capability. Policy lives in user-editable markdown.
- **Each handler builds its own context.** Don't preload everything. Give handlers short prompts and conventions for finding more context, then trust the agent to navigate.
- **Auditability over efficiency.** When in doubt, log it. Make every consequential decision inspectable.
- **One agent container, multiple watchers and agentruns.** Don't isolate handlers in separate containers. Process-level isolation gains nothing here and costs latency and IPC complexity.

## The `workspace/` folder

`workspace/` at the project root (gitignored) is mounted into the agent container as `/workspace`. The assistant's memory and personality live here (PROMPT.md, SOUL.md, CONTEXT.md, topic folders, people/, etc.). `familiar init` creates it empty; the daemon seeds it on every start from `data/workspace-template/` and the plugins' `workspace-template/` folders (missing files only). Host code reaches it via `boot.workspaceDir`, plugins via `ctx.workspaceDir`.

## The `data/` folder

The `data/` folder is the persistent host-side storage. Layout:

- `data/postgres/` — bind-mounted into `familiar-postgres` as `/var/lib/postgresql/data`. Cluster state for the bus-state DB. The container runs with `--user <hostUid>:<hostGid>` so cluster files are owned by the operator and `rm -rf data/postgres` works from the host without `sudo`. A daemon upgraded from the old uid-70 layout needs a one-time `sudo chown -R "$(id -u):$(id -g)" data/postgres`.

Ephemeral runtime scratch lives in `tmp/` instead (gitignored, safe to wipe):

- `tmp/.daemon.pid` — pidfile written by the daemon and consumed by `familiar stop`.
- `tmp/.postgres-port` — chosen loopback host port that `familiar-postgres` is published on (e.g. `5432`, or the next free port if 5432 was taken at startup). Read by anything host-side that wants to `psql` or use a `pg` client.
- `tmp/.bastion-token` — shared secret the running daemon's bastion requires on every request (header `x-familiar-bastion-token`, constant `BASTION_TOKEN_HEADER` in `shared/`). It comes from `core.bastionToken` in `config.yml` if that is set, otherwise it is random per start. The file is written with mode `0600`, so host-side CLI commands (`tools list`, `tools lint-mcps`, plugin CLIs using `ctx.mcp`) can authenticate. It is removed on shutdown.
- `tmp/llm-debug/` — model HTTP request/response captures written by the reverse proxy when `inference.captureModelHttpRequestBodies` is on. Pruned hourly to the last `inference.llmDebugRetentionDays` days (default 10).
- `tmp/scratch/` — per-event auxiliary files, bind-mounted into the agent and MCP containers as `/scratch/`.
- `tmp/mcp-mount-<id>/` — per-MCP bind-mount roots that double as `/work` for npx/uv caches.

## Architecture

- **shared/**: TypeScript package (`@getfamiliar/shared`) used by both host and container. Both sides depend on it via `"*"` workspace resolution in their package.json. Contains the `EventBus` / `AgentRunBus` / `PostgresConnection` clients, the events + agentruns schema (with `EVENT_TERMINAL_UPDATE_SQL` helper), and the related types. Must be built (`npm run build`) before host or container can compile. The Docker build handles this automatically.
- **host/**: Single Node.js CLI entry at `host/src/index.ts` using [citty](https://github.com/unjs/citty) for subcommand dispatch. Subcommands live in `host/src/commands/` (`Start`, `Stop`, `Event`, `Config`); shared paths live in `host/src/Bootstrap.ts`; the YAML-backed `ConfigService` and `ConfigLinter` live in `host/src/config/`. Invoked as `familiar <subcommand>` (from a monorepo checkout, `npm run dev -- <subcommand>` via the `cli/dev.mjs` launcher, which rebuilds stale packages first); every command except `init` verifies `config/config.yml` exists via `requireHomeDir`. The `start` subcommand runs as a long-running daemon that manages two singleton Docker containers: the bus-state postgres `familiar-postgres` and the agent runtime `familiar-agent`. Both join the shared bridge network `familiar-net`. Postgres is published on `127.0.0.1:<port>:5432` only (port chosen at startup; written to `tmp/.postgres-port`). All host↔container communication flows through the postgres `events` and `agentruns` tables — there is no file-based IPC.
- **host/src/db/**: Postgres lifecycle. `PostgresContainer` runs `postgres:16-alpine`, picks a free loopback port, joins `familiar-net`, and waits for `pg_isready`. Hardcoded user / database: `POSTGRES_USER=familiar`, `POSTGRES_DB=familiar`; the password is sourced from `core.postgresPassword` in `config/config.yml`. Container code reaches the DB at `familiar-postgres:5432`; host code at `127.0.0.1:<port>` (port from `tmp/.postgres-port`).
- **container/**: Docker container definition for the agent runtime. Long-running; built once, started by the host daemon and reused across all tasks.
  - Base image: `node:24-slim`. Currently no LLM SDK is installed — Featherless integration is the next step.
  - `src/TriageWatcher.ts` is a placeholder for the input-event watcher (claims events `pending → running`, currently just marks them done). The real input-event watcher and the new agentrun scheduler land in the next plan.
  - Runs as non-root `node` user.
  - Docker build context is the project root (not `container/`), so `shared/` is available during image build.
  - Both `container/src/` and `shared/build/` are bind-mounted into the running container (read-only), so source edits in either package take effect on the next daemon restart without an image rebuild. The `npm run dev` launcher keeps `shared/build/` fresh before the daemon starts. The agent image itself is (re)built on every `familiar start` via `ensureAgentImage` — docker's layer cache makes the no-change case fast, and `container/Dockerfile` or `package.json` changes are picked up automatically. The Dockerfile orders layers so source edits (`shared/`, `container/src/`) never invalidate the heavy download layers (apt, pip, npm install); pip/npm use BuildKit cache mounts, and every Dockerfile's `FROM` is pinned by digest so upstream tag republishes don't trigger rebuilds (bump pins deliberately via `docker buildx imagetools inspect <tag>`).

## CLI output

All **human-facing** CLI (and plugin) output is produced as markdown and emitted through `writeMarkdown` from `@getfamiliar/shared` (`shared/src/markdownOutput.ts`). It renders ANSI-styled via `renderMarkdown` (`shared/src/markdownTerminal.ts`) when stdout is a TTY, and emits the raw markdown verbatim when piped or redirected. The TTY check lives *inside* `writeMarkdown` — call sites never read `process.stdout.isTTY` themselves; they only optionally pass `{ raw: true }` (wired to a `--raw` flag) to force raw output on a TTY. So a command can never accidentally render box-drawing tables and ANSI escapes into a pipe. Build tables with `markdownTable(headers, rows)` (cells escaped via `escapeTableCell`). All three helpers are exported from `shared/` so plugins can use them too.

Every command that lists, tabulates, or reports for a human exposes `--raw` and ends by handing a markdown string to `writeMarkdown` — see `events list-crons`, `events list`/`events report`/`events list-topics`, `tools list`/`tools list-mcps`/`tools lint-mcps`, `plugins list`, `config lint`, `prompt placeholders`/`prompt dry-run`.

**Exceptions** (and why): the `start` daemon streams through the structured logger (ordering and flush matter); interactive prompts/wizards (`tools add-mcp`) write directly; machine-readable output stays literal (`events emit` prints JSON). The rule of thumb: *if it's a table, list, report, or prose status for a human to read, render it; if it's a stream, a prompt, or data for a machine, don't.*

## Agent tools

How to implement a tool the agent calls (container built-in vs. host core vs. plugin tool, registration, naming, groups, `level`, schema, description, `runJsonTool` & co., `ToolError`, tests) is described in `docs/agent-tools.md`. Read it before adding or changing a tool.

## Code Style

All TypeScript code is auto-formatted by [Biome](https://biomejs.dev/) on every edit (via a PostToolUse hook in `.claude/settings.json`). Do not manually adjust formatting.

### TypeScript Guidelines

- Document every function with a JSDoc comment: purpose, `@param`, `@returns`, and `@throws` where applicable.
- Use descriptive names — prefer `connectionTimeout` over `connTO`.
- Functions returning a boolean must start with `is` or `has` (e.g. `isLoopbackPortFree`, `hasPendingTasks`) — never the predicate-as-suffix form (`loopbackPortIsFree`).
- Prefer `const` over `let`. Never use `var`.
- Prefer early returns to reduce nesting depth.
- Keep functions focused and readable; extract helpers when complexity warrants it.
- Use `readonly` on properties and parameters that should not be reassigned.
- Handle errors explicitly — never swallow exceptions with empty catch blocks.
- Folders are named in lower kebab case (eg `mcp-server/`), files are PascalCase (eg `AgentRunner.ts`).

### Shell Scripts

- All shell scripts must pass [shellcheck](https://www.shellcheck.net/).
- Use `set -e` at the top of every script.
- Quote all variable expansions: `"${VAR}"` not `$VAR`.

### Markdown

- Do **not** hard-wrap prose at a column limit. A paragraph (or any semantically continuous block) stays on a single line; the viewer/IDE soft-wraps for display. Line breaks in markdown are reserved for real structure — paragraph boundaries, list items, headings.
- Code fences and tables keep their natural line structure.
- Existing files predating this convention may still have mid-paragraph hard wraps; when editing nearby content, opportunistically join wrapped paragraphs into single lines rather than doing a separate cleanup pass.

### Formatting & Linting

```bash
# From container/ or host/
npm run format        # Auto-format all source files
npm run format:check  # Check formatting without modifying (CI)
npm run lint          # Run linter
npm run check         # Format + lint combined
```
