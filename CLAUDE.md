# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Effective-assistant is an AI executive assistant built as a containerized agent. It observes the user's world (mail, calendar, chat, ticketing, etc.) and acts on the user's behalf — drafting, scheduling, summarizing, escalating — under explicit user approval for anything risky. The system is designed to be:

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
│  Input-event watcher, agentrun watcher                              │
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
- **Approval gate.** When a handler proposes a write that requires user confirmation, it writes a pending action to the database. The host watches for these (LISTEN/NOTIFY), pushes a notification (Telegram, web UI, etc.), and writes the user's response back to the database.
- **Logging service.** Centralized structured logging endpoint. Container watchers, individual agentruns, and host plugins all log here with event + agentrun lineage for correlation.
- **Container lifecycle.** The host starts the container, mounts plugin container-side directories and sets up the containers network including the MCP gateway.

### Container responsibilities

The container runs two pull-based watchers against the bus state database:

- **Input-event watcher.** Watches the `events` table for new rows in `pending`, atomically claims them (`pending → running`), and inserts a root `agentruns` row pointing at `<topic>/index.md` in the workspace. After that the input event is no longer of interest to the watcher; the event's terminal state is set reactively when its agentrun tree settles.
- **Agentrun watcher.** Watches the `agentruns` table for `pending` rows, atomically claims one (`pending → running`), resolves its handler markdown file, runs it via the agent runner, and settles it (`done`/`failed`). On terminal write the parent event's state is recomputed in the same transaction. **One agentrun runs at a time** for now (one supervisor slot on Featherless); per-model parallelism is a deferred open question.

A handler can queue follow-up agentruns by handler basename via a tool call (`queue_next("analyze", payload)`). This produces an arbitrary, branching workflow tree rooted at `<topic>/index.md` instead of a fixed pipeline.

The container has no direct network access except through the MCP gateway. It has no credentials. It can read and write its workspace and the bus state database.

## Event flow

A canonical event lifecycle:

1. **Host plugin** detects something in the world (e.g. new mail via IMAP IDLE) and calls a standardized event ingestion API on the host.
2. **Host** writes the event to the `events` table with a globally unique idempotency key. Topic matches `\w+(:\w+)?` (e.g. `mail:new`). `NOTIFY events_new` wakes the container.
3. **Container's input-event watcher** atomically claims the event (`pending → running`) and inserts a root `agentruns` row for it, with `handler=event.startHandler ?? 'index'` and `topic` copied from the event. `NOTIFY agentruns_changed` wakes the agentrun watcher.
4. **Agentrun watcher** claims the row (`pending → running`), resolves the handler markdown file (see "Handler resolution"), and runs an agent session against it. The handler's content is the prompt; the agent has MCP tools and the `queue_next` tool.
5. **Inside the handler**, the agent decides what to do next. It may call MCP tools, edit workspace files, and call `queue_next(handler, payload)` to spawn child agentruns (e.g. `index.md` triages, then queues `analyze` and `respond`). Each child is another `agentruns` row with `parent_agentrun_id` set to the spawning row and `event_id` propagated.
6. **For risky writes**, the handler proposes a **pending action** through the approval gate. The agentrun **suspends** until the user responds, then resumes and continues. Suspend/resume mechanics are TBD — see open questions.
7. **When the agentrun finishes**, `AgentRunBus.settle()` writes its terminal state and, in the same transaction, recomputes the parent event's state via `EVENT_TERMINAL_UPDATE_SQL`: the event flips to `done` once no `pending`/`running` agentruns remain for it, or `failed` if any agentrun in the tree failed. `NOTIFY events_state` lets host plugins react to the final outcome (e.g. send a chat reply back to the user).
8. **Consequence events** (a write that triggers another world change) re-enter step 1 as fresh events with a new id. There is no global causation chain across events; lineage *within* an event lives on `agentruns.parent_agentrun_id`. Producers can pass parent context in the new event's payload if needed.

### Handler resolution

The agentrun's `topic` and `handler` fields determine which markdown file to load. Override rule for a topic like `chat:telegram` and handler `analyze`:

1. Try `workspace/chat/telegram/analyze.md`.
2. Fall back to `workspace/chat/analyze.md`.

The override applies uniformly to all handlers, not just `index`. Validation happens at `queue_next` time: the tool resolves the path and refuses to queue if neither file exists, so the calling agent gets a synchronous error.

### Safety mechanisms

- **Tree-depth limit on agentrun lineage.** The `parent_agentrun_id` chain has a maximum depth (default 3, configurable). Past that, `queue_next` refuses to spawn and the user is notified. Prevents runaway loops.
- **Tool budget per agent invocation.** Each agentrun has a hard tool-call limit (default 15). Exceeding it terminates the run as `failed` and logs the failure. Protects against models that loop on weaker tool-calling adherence.

## Storage layers

Three distinct storage layers, each with a clear purpose and owner.

### 1. Bus state (host, transactional)

Postgres database, owned by the host. Both host and container access it via the shared `EventBus` / `AgentRunBus` clients in `shared/`. Two tables today:

- `events` — `id`, `topic` (CHECK against `\w+(:\w+)?`), `priority`, `state` (`pending|running|done|failed`), `payload`, `idempotency_key`, timestamps. Immutable record of "the world said this happened". State transitions are bookkeeping — nothing wakes on them except host-side completion waiters via `NOTIFY events_state`.
- `agentruns` — `id`, `event_id` (FK), `parent_agentrun_id` (self-FK, null for root), `topic`, `handler`, `priority`, `state` (`pending|running|done|failed`), `prompt`, `payload`, `result`, `error`, timestamps. The assistant's response tree per event.

Three NOTIFY channels: `events_new` (INSERT into events; wakes the input-event watcher), `events_state` (state UPDATE on events; for host-side completion waiters), `agentruns_changed` (INSERT and state UPDATE on agentruns; wakes the agentrun watcher).

Planned but not yet implemented: `pending_actions` (approval gate), `scheduled_triggers` (one-shot triggers from workflows, e.g. "30 min before this meeting"), `audit_log`.

### 2. Workspace (container, markdown)

Mounted directory, the assistant's process handbook, memory and personality. Structure:

```
workspace/
  SOUL.md                   # the assistant's core identity and values, read by every handler
  CONTEXT.md                # situational context — the job, relations, duties etc.
  ENVIRONMENT.md            # description of the system environment for the agent's situational awareness
  <topic>/                  # one folder per top-level topic (e.g. mail/, chat/, calendar/) - the user can invent new ones as needed, some are shipped by plugins
    index.md                # default entry-point handler for events of this topic
    analyze.md              # additional handler, queued by name from another handler
    daily-digest.md         # example of a handler with "cron"
    ...
    <subtopic>/             # optional override folder for `<topic>:<subtopic>`
      index.md              # overrides the parent index.md for this subtype
      analyze.md            # overrides the parent analyze.md
      ...
```

Handler files are plain markdown. They are usually authored by the user but can be created and modified by privileged event handlers.

### 3. Configuration and secrets (host, YAML)

All configuration — sensitive and non-sensitive — lives in `config/config.yml` (gitignored;
`config/config.example.yml` is the tracked sample). The host accesses it via two services:

- **`ConfigService`** (interface in `shared/src/Config.ts`, implementation in
  `host/src/config/ConfigService.ts`) is the runtime read/write surface. Plugin-agnostic; exposes
  `getString(key)` / `getNumber(key)` / `getArray(key)` keyed by dotted paths (e.g.
  `"core.postgresPassword"`, `"telegram.botToken"`), with optional defaults that widen the return
  type to include the default when omitted-vs-throws is the difference between "throw on missing"
  and "return null". Plugins reach it via `ctx.config`. **No plugin-specific types in `shared/`.**
- **`ConfigLinter`** (`host/src/config/ConfigLinter.ts`) validates the file at boot: file readable,
  parses as a YAML mapping, contains the platform-level minimum (`core.postgresPassword`,
  `core.defaultChatChannel`, `inference.provider`, `inference.defaultModel`,
  `inference.apiKeys.<provider>`). Unknown top-level groups are ignored — plugins own their own
  keys, the platform doesn't enumerate them.

Top-level groups in `config/config.yml`:

- `core` — `postgresPassword`, `defaultChatChannel`, optional `logRetentionDays`. Required.
- `inference` — `provider`, `defaultModel`, `apiKeys.<provider>` map. Required.
- per-plugin (`telegram`, `whatsapp`, …) — owned by the plugin; plugin parses its own subtree and
  self-disables when absent.

Container-side env stays explicit: `Start.ts` reads from the config service and hand-picks which
values become container env vars. **Proxy-placeholder API keys** (e.g. `FEATHERLESS_API_KEY=via-proxy`
inside `ea-agent`) are hardcoded in the container launcher (`AgentContainer.ts`); the real upstream
key only flows from config → `ReverseProxyContainer.upstreamApiKey`.

CLI: `./cli.sh config lint` validates the file. `./cli.sh start` runs the linter implicitly before
bringing the daemon up.

Note that `config/mcp.yml` contains the configuration for MCP tools and likely contains sensitive information like API keys as well.

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

A plugin may emit events on any number of topics and usually ships default handlers for the emitted events in its folder under `workspace-template/`. The daemon checks all workspace templates on startup and copies new / missing files to the `data/workspace` directory.

### Plugin manifest (in package.json)

Declares:

- Plugin id (`[a-z0-9-]+`), version
- Event topics produced (with payload schema), each matching `\w+(:\w+)?`
- MCPs required (with required scopes)
- MCPs provided (optional)
- Cronjobs and daemons (with schedule and entry points)

## Cronjobs

Any handler can declare a `cron:` field in its YAML frontmatter. The host's
`CronjobScheduler` (in `host/src/cron/`) scans the workspace at daemon startup, watches for
file changes via the generalized `WorkspaceWatcher` (in `host/src/workspace/`), and
registers a Croner job per valid expression. When the cron fires, the scheduler emits a
fresh event whose `topic` and `startHandler` resolve to the same `.md` file, with the
prompt `"The cronjob has fired"` and no payload.

The expression is parsed by `friendly-node-cron` first (`every monday at 8 am`,
`every 5 minutes`, `weekly`, …). If the friendly grammar doesn't match, the verbatim string
is passed straight to Croner as a raw cron expression. Invalid expressions are logged at
`warn` and silently dropped; the rest of the workspace keeps working. Editing or deleting
a handler file re-evaluates its job live — no daemon restart needed.

`ea cron list` prints every handler with a `cron:` field, the verbatim string, and the
parsed expression. The command runs a standalone filesystem scan, so it works whether the
daemon is up or not.

Example: `workspace/emails/monday-digest.md`

```markdown
---
cron: every monday at 8
---
# Send a week-ahead briefing via Telegram

Compile a briefing of calendar events, open tasks with deadlines this week, and unread
mails marked important. Send the briefing via Telegram.
```

**Handler placement rule:** handler markdown files must live under at least one topic
folder (e.g. `workflows/<name>.md`, `mail/digest.md`).

### Editing handlers via chat

When the user asks for it in the chat, the agent can edit the handler markdown files to reflect the requested behaviors.

## Markdown layers and self-organization

Handler behavior is shaped by markdown files in layers, each with distinct ownership and purpose:

- **Code-level capability** — what plugins make possible (in TypeScript/MCPs)
- **Global context** — `SOUL.md`, `ENVIRONMENT.md` and `CONTEXT.md`, written by the user to define the assistant's identity and situational context
- **Handler layer** — per-topic handler files (`<topic>/index.md`, `<topic>/analyze.md`, …) and sub-topic overrides (`<topic>/<subtopic>/…`). Plugin-shipped defaults, user-editable.
- **Knowledge layer** — facts about people, projects, etc. (`people/`, plugin-specific), built up over time by handlers themselves, correctable by the user

Handler prompts are kept short. They tell the agent how to find more context (e.g. "always read `people/<sender>.md` before drafting a reply"). The agent pulls additional files into context as needed. This avoids loading large amounts of context into every prompt and lets the assistant build its own knowledge structure over time, guided by user conventions.

## Lifecycle and operations

### Plugin lifecycle

- **Cronjobs** — stateless, idempotent. On exception: log and continue at next schedule. Use `node-cron` or `bullmq`.
- **Daemons** (long-running processes like IMAP IDLE, Telegram bot) — exponential backoff on restart (1s → 2s → 4s → ... up to 5min cap).
- **Graceful shutdown** — SIGTERM with 10s grace period; plugins should drain in-flight operations and persist any pending state.

### Logging

All components log using a centralized logging service. Fields include plugin id, severity, timestamp, lineage (event id + agentrun id + parent agentrun id), message, structured context. The host persists with rotation. Logs can be correlated across host plugins, container watchers, and individual agentruns.

## Concurrency and model usage

Each handler's markdown file declares which model the agent runs under. The heavy model (V4 Pro) is the bottleneck: Featherless's premium tier exposes one concurrent slot for 70B+ models.

To keep things simple for now:

- The agentrun watcher processes **one agentrun at a time**, FIFO within priority. Priority is inherited from the parent event (set by the host plugin that ingested the event).
- Lightweight handlers (V4 Flash) currently share the same single-slot watcher. Per-model concurrency limits — letting Flash handlers run in parallel with one heavy handler — are deferred until the bottleneck actually bites.

The provider boundary is abstracted. The model client interface allows swapping Featherless, DeepSeek-API direct, Anthropic, etc., without changes to handler code or watcher logic. This is important both for cost control and for long-term resilience as open-weight models evolve.

**Inference error policy.** Retryable `APICallError`s (408/429/5xx — including Featherless's
`503 "Model is over capacity"`) do not block the watcher slot. `AgentRunner` postpones the row
by writing it back to `pending` with a future `not_before` and bumping `retry_count`; the
watcher claims it again when the time arrives, and other agentruns (potentially using
different models) can run in the meantime. Delay is taken from `retry-after[-ms]` headers when
present and reasonable, else exponential backoff (2s → 4s → … capped at 5 min). Cap defaults
to 3 (`inference.maxRetries` in `config.yml`) and can be overridden per-handler via a
`maxRetries` field in YAML frontmatter (set to 0 there to disable retries for one handler).
Non-retryable errors (404 wrong model id, 401 bad key, 400 bad request) fail fast with a
`formatInferenceError`-rendered message on `agentruns.error` ("The model API answered with
404 Not Found at https://… — <body excerpt>"). The Vercel AI SDK's own `maxRetries` is set to
0 so it doesn't block inside `agent.generate()`; we own the retry loop.

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
3. **Per-model concurrency limits.** The agentrun watcher is single-slot today. Letting lightweight handlers run in parallel with one heavy handler is straightforward (model column on `agentruns`, watcher claim filter), but only worth the complexity once the single slot is actually a bottleneck.
4. **Diff/merge on plugin updates** — when a plugin update brings new defaults but the user has customized their copy, present a diff and let the user choose. Even better: let the LLM handle the merge in a guided dialogue.
5. **Web UI for workspace inspection and audit log browsing** — useful for debugging and understanding system behavior.
6. **Eval harness** — a way to replay events against the system and measure handler quality. Critical for confidently swapping models or tuning prompts.

## Implementation order suggestion

1. **Bus state schema and access** — done: `events` and `agentruns` tables, `EventBus` and `AgentRunBus` clients in `shared/`, reactive event-terminal logic via `EVENT_TERMINAL_UPDATE_SQL`.
2. **Container watchers** — input-event watcher (events `pending → running`, spawns root agentrun) and agentrun watcher (agentruns `pending → running → done|failed`, runs handler markdown via the agent runner). The current `TriageWatcher.ts` is a stub for the input-event watcher; replace it next.
3. **Handler resolution + `queue_next` tool** — workspace path resolver with sub-topic override fallback, plus the in-handler tool that queues child agentruns by basename and validates at queue time.
4. **Plugin loader and lifecycle** — host-side plugin loading, manifest parsing, container mount of `mcps/`, `workspace-template/` copy on first install.
5. **Logging service** — centralized structured logging.
6. **Approval gate** — `pending_actions` table, suspend/resume mechanics (per the open question above), notification push (start with Telegram or simple web UI), response handling.
7. **First real plugin** — mail plugin end to end as the reference implementation: IMAP IDLE in host, `mail/index.md` (and optionally `mail/new/index.md`) handlers in workspace-template, MCP for mail operations behind the gateway.
8. **Cron scheduler** — host-side scanning of handler frontmatter for `cron:` fields,
   live re-evaluation on file change, event emission on firing. *(Implemented:
   `host/src/cron/`, `host/src/workspace/WorkspaceWatcher.ts`.)*
9. **Additional plugins** — calendar, Jira, Telegram, chat (probably web UI for chat).

## Design principles to preserve

When in doubt during implementation:

- **Pull, don't push.** Container pulls work from the database. Host writes events, but does not invoke functions in the container.
- **Markdown is the user-facing API.** If the user needs to configure or extend something, the answer is a markdown file in the workspace, not a config schema or UI form (unless it's about presenting markdown).
- **Capability vs. policy separation.** Plugins ship capability. Policy lives in user-editable markdown.
- **Each handler builds its own context.** Don't preload everything. Give handlers short prompts and conventions for finding more context, then trust the agent to navigate.
- **Auditability over efficiency.** When in doubt, log it. Make every consequential decision inspectable.
- **One agent container, multiple watchers and agentruns.** Don't isolate handlers in separate containers. Process-level isolation gains nothing here and costs latency and IPC complexity.

## The `data/` folder

The `data/` folder is the persistent host-side storage. Layout:

- `data/workspace/` — mounted into the agent container as `/workspace`. The assistant's memory and personality live here (SOUL.md, CONTEXT.md, topic folders, people/, etc.).
- `data/postgres/` — bind-mounted into `ea-postgres` as `/var/lib/postgresql/data`. Cluster state for the bus-state DB. The container runs with `--user <hostUid>:<hostGid>` so cluster files are owned by the operator and `rm -rf data/postgres` works from the host without `sudo`. A daemon upgraded from the old uid-70 layout needs a one-time `sudo chown -R "$(id -u):$(id -g)" data/postgres`.
- `data/.daemon.pid` — pidfile written by the daemon and consumed by `./cli.sh stop`.
- `data/.postgres-port` — chosen loopback host port that `ea-postgres` is published on (e.g. `5432`, or the next free port if 5432 was taken at startup). Read by anything host-side that wants to `psql` or use a `pg` client.

## Architecture

- **shared/**: TypeScript package (`effective-assistant-shared`) used by both host and container. Both sides depend on it via `"file:../shared"` in their package.json. Contains the `EventBus` / `AgentRunBus` / `PostgresConnection` clients, the events + agentruns schema (with `EVENT_TERMINAL_UPDATE_SQL` helper), and the related types. Must be built (`npm run build`) before host or container can compile. The Docker build handles this automatically.
- **host/**: Single Node.js CLI entry at `host/src/index.ts` using [citty](https://github.com/unjs/citty) for subcommand dispatch. Subcommands live in `host/src/commands/` (`Start`, `Stop`, `Event`, `Config`); shared paths live in `host/src/Bootstrap.ts`; the YAML-backed `ConfigService` and `ConfigLinter` live in `host/src/config/`. Invoked through one root wrapper, `./cli.sh <subcommand>`, which verifies `config/config.yml` exists and rebuilds the host package if stale. The `start` subcommand runs as a long-running daemon that manages two singleton Docker containers: the bus-state postgres `ea-postgres` and the agent runtime `ea-agent`. Both join the shared bridge network `ea-net`. Postgres is published on `127.0.0.1:<port>:5432` only (port chosen at startup; written to `data/.postgres-port`). All host↔container communication flows through the postgres `events` and `agentruns` tables — there is no file-based IPC.
- **host/src/db/**: Postgres lifecycle. `PostgresContainer` runs `postgres:16-alpine`, picks a free loopback port, joins `ea-net`, and waits for `pg_isready`. Hardcoded dev credentials: `POSTGRES_USER=ea`, `POSTGRES_PASSWORD=ea`, `POSTGRES_DB=ea`. Container code reaches the DB at `ea-postgres:5432`; host code at `127.0.0.1:<port>` (port from `data/.postgres-port`).
- **container/**: Docker container definition for the agent runtime. Long-running; built once, started by the host daemon and reused across all tasks.
  - Base image: `node:24-slim`. Currently no LLM SDK is installed — Featherless integration is the next step.
  - `src/TriageWatcher.ts` is a placeholder for the input-event watcher (claims events `pending → running`, currently just marks them done). The real input-event watcher and the new agentrun watcher land in the next plan.
  - Runs as non-root `node` user.
  - Docker build context is the project root (not `container/`), so `shared/` is available during image build.
  - Both `container/src/` and `shared/build/` are bind-mounted into the running container (read-only), so source edits in either package take effect on the next daemon restart without an image rebuild. `cli.sh` keeps `shared/build/` fresh before the daemon starts. The agent image itself is (re)built on every `./cli.sh start` via `ensureAgentImage` — docker's layer cache makes the no-change case fast, and `container/Dockerfile` or `package.json` changes are picked up automatically.

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

- Wrap prose at **100 characters**, matching the TypeScript line width in `biome.json`. Don't reflow at 70/80; the wider width matches modern editors.
- Code fences and tables are exempt — leave them at their natural width.
- Existing files predating this convention may have varying wrap widths; reflow opportunistically when editing nearby content, not as a separate cleanup pass.

### Formatting & Linting

```bash
# From container/ or host/
npm run format        # Auto-format all source files
npm run format:check  # Check formatting without modifying (CI)
npm run lint          # Run linter
npm run check         # Format + lint combined
```
