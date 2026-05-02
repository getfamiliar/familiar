# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Effective-assistant is an AI executive assistant built as a containerized agent. It observes the user's world (mail, calendar, chat, ticketing, etc.) and acts on the user's behalf — drafting, scheduling, summarizing, escalating — under explicit user approval for anything risky. The system is designed to be:

- **Proactive, not reactive.** It reacts to world events (incoming mail, calendar invitations, Jira webhooks), not just user prompts.
- **Personal.** The assistant's behavior is shaped by markdown files the user can edit. The "personality" lives in the workspace, not in code or model weights.
- **Extensible.** Plugins add capabilities (new event sources, new tools). Rules and workflows let the user compose behavior without writing code.
- **Auditable.** Every decision and action leaves a trace. The user can read why something happened.
- **Safely sandboxed.** Reasoning runs in a container that cannot see credentials. The host injects auth into MCP calls via a reverse proxy.

Using open-weight models is the deliberate choice to keep costs predictable and be able to run the assistant on a flatrate basis.

# Architecture Overview

## Stack

- **TypeScript** end to end (host and container)
- **Docker** with a single agent container plus the Docker MCP Toolkit for tool aggregation
- **Postgres** for bus state (uses LISTEN/NOTIFY for event signaling)
- **Markdown** for all user-facing configuration, rules, instructions, and the assistant's accumulated knowledge

Concerning LLM models, the system is flexible but opinionated towards:

- **Featherless.ai** as primary LLM provider (flat-rate, broad model selection); architecture is provider-agnostic so DeepSeek-API direct or Anthropic remain viable fallbacks
- **DeepSeek V4 Pro** as supervisor model, **V4 Flash** for triage and lightweight subagent work


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
                          pulls events       all MCP calls
                          via LISTEN/NOTIFY  go through gateway
                                  │                  │
┌─────────────────────────────── CONTAINER ───────────────────────────┐
│  Triage workers, action workers, supervisor                         │
│  Plugin container-side code mounted in                              │
│  Workspace (markdown files: instructions, rules, workflows,         │
│   people, projects, plugin-specific knowledge)                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Host responsibilities

- **Plugin lifecycle.** Plugins are npm packages. Each declares a manifest. The host loads them, runs their host-side code (event sources, daemons, cronjobs), and mounts their container-side code into the agent container.
- **Event ingestion.** Host-side plugin code produces events (incoming mails, Slack via socket, Jira via webhook, scheduled triggers, etc.) and writes them to the bus state database with idempotency checks.
- **Credential management.** OAuth tokens, API keys, and similar secrets live in the host. They are never passed to the container. The host refreshes tokens via cronjobs and injects them at call time through the MCP gateway.
- **MCP gateway.** All MCP servers are aggregated behind the Docker MCP Toolkit gateway. The container sees a single endpoint. Per-call authentication is injected by the gateway based on the calling subagent's permissions.
- **Approval gate.** When the container proposes a write action that requires user confirmation, it writes a pending action to the database. The host watches for these (LISTEN/NOTIFY), pushes a notification (Telegram, web UI, etc.), and writes the user's response back to the database.
- **Logging service.** Centralized structured logging endpoint. Container, supervisor, subagents, and host plugins all log here with event lineage for correlation.
- **Container lifecycle.** The host starts the container, mounts plugin container-side directories and sets up the containers network including the MCP gateway.

### Container responsibilities

The container runs three independent worker loops, all pull-based against the bus state database:

- **Triage worker.** Pulls events from the event queue. For each event, runs all subscribed plugin triage functions (independently — see "Triage" below). Writes resulting deterministic actions to the action queue or supervisor jobs to the supervisor queue.
- **Action worker.** Pulls deterministic actions from the action queue. Executes them via MCP calls. Writes audit entries.
- **Supervisor worker.** Pulls supervisor jobs from the priority queue (chat > normal > low, FIFO within priority). One job at a time due to concurrency limits on the supervisor model. Plans and executes via MCP calls and subagent invocations. Proposes pending actions through the approval gate.

The container has no direct network access except through the MCP gateway. It has no credentials. It can read and write its workspace and the bus state database.

## Event flow

A canonical event lifecycle:

1. **Host plugin** detects something in the world (e.g. new mail via IMAP IDLE) and calls a standardized event ingestion API on the host.
2. **Host** writes the event to the `events` table with a globally unique idempotency key. Postgres NOTIFY is sent.
3. **Container's triage worker** wakes up, claims the next pending event with `UPDATE ... WHERE state='pending' RETURNING *` (atomic), and reads it.
4. **Triage worker** identifies all plugins subscribed to the event's topic and invokes their triage functions independently. Each can return one of three outcomes:
   - `ignore` (this plugin doesn't care about this event)
   - `deterministic action` (run a specific tool sequence directly)
   - `supervisor job` (build a prompt and queue a supervisor task)
   
   Multiple plugins may all return non-ignore outcomes — they are processed independently. There is no consensus mechanism.
5. **Triage worker** writes resulting actions to the action queue and/or supervisor jobs to the supervisor queue, marks the event as `triaged`.
6. **Action worker** picks up deterministic actions, runs them, writes audit entries.
7. **Supervisor worker** picks up jobs by priority. The supervisor (V4 Pro) plans and executes, calling subagents (often V4 Flash) and MCPs. Reads from workspace markdown for context.
8. For risky writes, the supervisor proposes a **pending action** (or compound pending action) through the approval gate.
9. **User** receives notification, approves or modifies. Approval gate updates the database.
10. **Action worker** picks up approved actions, executes them, writes audit. May emit follow-up events (e.g. `calendar.event_moved`), which re-enter the loop at step 1 — with hop counter tracking to prevent runaway chains.

## Inter-agent communication

This is the architectural heart of the system. The rules:

- **Reads can cross agent boundaries.** A subagent can synchronously call another subagent's read-only tools (e.g. `schedule.find_slots`). MCPs can also be called directly when no subagent reasoning is needed for the read.
- **Writes are linear.** Writes never cascade through agent-to-agent calls. They flow only via: triage → domain agent → approval gate → action worker.
- **Consequence writes go back through the bus.** If a write produces a follow-up effect (calendar move triggers Jira update), this happens by emitting a new event with `causation_chain` extended, which re-enters triage. This guarantees every write passes through approval logic and audit, and prevents hidden agent-to-agent triggering.

### Safety mechanisms

- **Hop counter on causation chain.** Events carry their full lineage. Beyond a configured depth (default 3), processing halts and the user is notified. Prevents runaway loops even if the supervisor misbehaves.
- **Tool budget per agent invocation.** Each agent run has a hard tool-call limit (default 15). Exceeding it terminates the run and logs the failure. Protects against models that loop on weaker tool-calling adherence.
- **Whitelist of cross-agent reads.** Allowed read targets are declared statically in plugin manifests, not negotiated at runtime. The possible call graph is therefore knowable in advance.

## Storage layers

Three distinct storage layers, each with a clear purpose and owner.

### 1. Bus state (host, transactional)

Postgres database, owned by the host. The container accesses it through a host-provided MCP server ("bus state MCP") so that all bus operations are uniformly auditable. Tables include:

- `events` — all events, with `causation_chain`, `idempotency_key`, `priority`, `topic`, `state`, payload
- `pending_actions` — triaged events ready for the supervisor and proposed writes awaiting approval, with `compound_id`, `state`, `expires_at`
- `scheduled_triggers` — one-shot scheduled events created by event-based rules (e.g. "30 min before this specific meeting")
- `audit_log` — append-only record of all consequential actions

### 2. Workspace (container, markdown)

Mounted directory, the assistant's "memory and personality." Conventions:

```
workspace/
  SOUL.md                   # the assistant's core identity and values, read by supervisor on every job
  CONTEXT.md                # situational context for the assistant - the job, relations, duties etc.
  workflows/                # time-driven workflows (user-defined cronjobs)
    monday-digest.md
    monthly-spending-review.md
    ...
  people/                   # cross-plugin facts about people
    anna.md                 # written and updated by supervisor, user-correctable
    ...
  <plugin>/                 # plugin-specific space
    instructions.md         # plugin-default, user-editable
    <event-type>.md         # event-specific guidance, user-editable
    rules/                  # event-driven rules (user-defined)
      coaching-prep.md
      newsletter-archive.md
      ...
```

Files are plain markdown. The supervisor reads and writes them through the file-system MCP. The workspace can be backed by a git repo for free versioning.

### 3. Plugin configuration and secrets (host, encrypted)

* There's a global config file in `config/config.yml` for all non-sensitive settings.
* Credentials are stored in the project root `.env` file.

## Plugins

Plugins are npm packages with a standard structure:

```
my-plugin/
  package.json              # with manifest under `assistant` field
  host/                     # runs in host process
    index.ts                # event sources, cronjobs, daemons
  container/                # mounted into container
    triage.ts               # triage functions for subscribed event topics
    mcps/                   # plugin-provided MCP servers (optional)
  workspace-template/       # copied into workspace on first install
    instructions.md
    new-event.md
    ...
```

### Plugin manifest (in package.json)

Declares:

- Plugin id ([a-z0-9-]+), version
- Event topics produced (with payload schema)
- Event topics subscribed (for triage)
- MCPs required (with required scopes)
- MCPs provided (optional)
- Cronjobs and daemons (with schedule and entry points)

## Rules and workflows

The user can extend behavior in two ways without writing code, both via markdown files in the workspace.

### Rules (event-driven)

Files in `workspace/{plugin}/rules/`. Each rule's first line describes when the rule applies and what it does (one sentence containing both trigger and action). The rest of the file contains the detailed instructions.

Example: `workspace/calendar/rules/coaching-prep.md`

```markdown
For events with "Coaching" in the title

# Coaching call preparation message

## Trigger
A new event in the calendar whose title contains "Coachinggespräch".

## Action
30 minutes before the meeting starts:
1. Identify the meeting partner from the attendees.
2. Search Jira for the last 5 tickets edited or commented by that person.
3. Summarize and send via Telegram.
```

Rules are evaluated for every positive plugin triage by the calling environment using a two-stage retrieval:

1. **Index scan.** A platform helper builds a compact prompt with all rule first-lines plus the current event, asks V4 Flash which rules to consider, returns a shortlist of file paths.
2. **Detail evaluation.** Only shortlisted files are loaded fully and used to drive the triage decision (typically: produce a supervisor job, or schedule a one-shot trigger via `scheduled_triggers`).

This pattern keeps rule evaluation cheap even with many rules. Rule files that are evaluated as being relevant are added to the prompt returned by the triage function, so they can be used for context and guidance in the supervisor job.

### Workflows (time-driven)

Files in `workspace/workflows/`. Same first-line convention. Parsed by the workflow plugin, which extracts the schedule and registers a cronjob. When the cronjob fires, an event is emitted that proceeds through the normal pipeline.

Example: `workspace/workflows/monday-digest.md`

```markdown
# Every Monday at 8 AM, send a week-ahead briefing via Telegram

## Schedule
Every Monday at 8:00 in local time.

## Action
Compile a briefing of:
- Calendar events for the upcoming week
- Open tasks with deadlines this week
- Any unread mails marked important

Send the briefing via Telegram.
```

### Editing rules and workflows via chat

When the user expresses a behavior change in chat ("remember: Anna gets priority on mails"), the supervisor identifies the edit intent and edits the relevant markdown files.

## Markdown layers and self-organization

The supervisor's behavior is shaped by markdown files in layers, each with distinct ownership and purpose:

- **Code-level capability** — what plugins make possible (in TypeScript/MCPs)
- **Global instructions** — `SOUL.md` and `CONTEXT.md`, written by the user to define the assistant's identity and situational context
- **Plugin + event layer** — plugin-shipped instructions per plugin (`<plugin>/instructions.md`) and per event type (`<plugin>/<event-type>.md`), user-editable defaults
- **Behavior layer** — user-defined rules (`rules/`) and workflows (`workflows/`)
- **Knowledge layer** — facts about people, projects, etc. (`people/`, plugin-specific), built up over time by the supervisor itself, correctable by the user

System prompts are kept short. Plugin instructions tell the supervisor how to find more context (e.g. "always read `people/<sender>.md` before processing a mail"). The supervisor pulls additional files into context as needed. This avoids loading large amounts of context into every prompt and lets the assistant build its own knowledge structure over time, guided by user conventions.

## Lifecycle and operations

### Plugin lifecycle

- **Cronjobs** — stateless, idempotent. On exception: log and continue at next schedule. Use `node-cron` or `bullmq`.
- **Daemons** (long-running processes like IMAP IDLE, Telegram bot) — exponential backoff on restart (1s → 2s → 4s → ... up to 5min cap).
- **Health checks** — plugin-required `healthcheck()` method called every 30s by host. No response within 5s ⇒ restart. !!! NOT SURE HOW TO IMPLEMENT THIS, MAYBE RECONSIDER OR TURN INTO A HEARTBEAT
- **Graceful shutdown** — SIGTERM with 10s grace period; plugins should drain in-flight operations and persist any pending state.

### Logging

All components log using a centralized logging service. Fields include plugin id, severity, timestamp, event lineage (causation chain id), message, structured context. The host persists with rotation. Logs can be correlated across host plugins, container workers, and the supervisor by causation chain.

## Concurrency and model usage

The supervisor model is the bottleneck under Featherless premium tier (one concurrent slot for 70B+ models). The architecture accommodates this:

- Triage uses V4 Flash with multiple concurrent slots — high-throughput, cheap, parallelizable.
- Action workers do not use the supervisor — they run deterministic tool sequences and can run multiple in parallel.
- Supervisor jobs are processed sequentially, FIFO within priority class. Chat events have priority over mail/calendar/etc. Burst handling: jobs queue and are processed as the slot frees.

Subagent role-modeling (which model handles which subtask) is constrained by both task fit and concurrency: complex domain reasoning that needs the supervisor's slot would block. Drafting subagents and similar can run in V4 Flash.

The provider boundary is abstracted. The model client interface allows swapping Featherless, DeepSeek-API direct, Anthropic, etc., without changes to agent code. This is important both for cost control and for long-term resilience as open-weight models evolve.

## Approval gate

For any action classified as risky (configurable per tool, declared in the plugin manifest):

- The supervisor writes a `pending_action` row, taking resource locks as needed.
- The host's approval service watches for new pending actions (LISTEN/NOTIFY), pushes a notification with action details, accepts user response (approve / modify / reject) via Telegram, web UI, or other configured channel.
- On approve: action worker executes; locks released after success/failure.
- On reject or timeout: pending action marked rejected, locks released.
- Compound actions (multiple writes that must commit together) share a `compound_id` and are executed atomically with rollback on partial failure.

Risk classification levels:

- **Autonomous** — execute without approval (e.g. mark mail as read, archive obvious newsletter).
- **Notify-on-default-approve** — proposed with a short timeout (e.g. 5 min) after which auto-approve unless rejected.
- **Approval-required** — must be explicitly approved.

## Open questions for implementation

The following are deliberately deferred but should be addressed during implementation:

1. **Diff/merge on plugin updates** — when a plugin update brings new defaults but the user has customized their copy, present a diff and let the user choose. OR EVEN BETTER: Let the LLM handle the merge in a guided dialogue!
2. **Web UI for workspace inspection and audit log browsing** — useful for debugging and understanding system behavior.
3. **Eval harness** — a way to replay events against the system and measure subagent quality. Critical for confidently swapping models or tuning prompts.

## Implementation order suggestion

1. **Bus state schema and access** — events, pending_actions, resource_locks, cross_references, scheduled_triggers, audit_log. Plus the bus state MCP server.
2. **Container worker loops** — triage, action, supervisor, with simple stub implementations that just log.
3. **Plugin loader and lifecycle** — host-side plugin loading, manifest parsing, container mount, basic lifecycle management.
4. **Logging service** — centralized structured logging.
5. **Approval gate** — pending actions table, notification push (start with Telegram or simple web UI), response handling.
6. **First real plugin** — mail plugin end to end as the reference implementation: IMAP IDLE in host, triage in container, MCP for mail operations behind the gateway, default workspace markdown, one or two example rules.
7. **Workflow plugin and rule helper** — built-in workflow scanning and rule index-scan helper.
8. **Additional plugins** — calendar, Jira, Telegram, chat (probably web UI for chat).

## Design principles to preserve

When in doubt during implementation:

- **Pull, don't push.** Container pulls work from the database. Host writes events, but does not invoke functions in the container.
- **Reads cross, writes don't.** Read-only tool calls between agents are fine. Writes only flow through triage → domain agent → approval → action.
- **Markdown is the user-facing API.** If the user needs to configure or extend something, the answer is a markdown file in the workspace, not a config schema or UI form (unless it's about presenting markdown).
- **Capability vs. policy separation.** Plugins ship capability. Policy lives in user-editable markdown.
- **The supervisor builds its own context.** Don't preload everything. Give the supervisor short instructions and conventions for finding more context, then trust it to navigate.
- **Auditability over efficiency.** When in doubt, log it. Make every consequential decision inspectable.
- **One agent container, multiple workers.** Don't isolate subagents in separate containers. Process-level isolation gains nothing here and costs latency and IPC complexity.

## The `data/` folder

The `data/` folder is the persistent host-side storage. Layout:

- `data/workspace/` — mounted into the agent container as `/workspace`. The assistant's memory and personality live here (SOUL.md, CONTEXT.md, plugin folders, people/, etc.). The container persists the most recent SDK session id to `data/workspace/.last-session` so subsequent chat tasks resume the same conversation.
- `data/ipc/input/` and `data/ipc/output/` — task IPC. The chat CLI writes `{taskId}.json` to `input/`; the container's TaskLoop drains it, runs the task, and writes `{taskId}.json` to `output/`. The host daemon stays out of this path.
- `data/.claude/` — mounted into the container as `/home/node/.claude`. Holds the Agent SDK's session store so resume works across container restarts.
- `data/postgres/` — bind-mounted into `ea-postgres` as `/var/lib/postgresql/data`. Cluster state for the bus-state DB. Files are owned by the postgres uid (70 in alpine), so `rm -rf data/postgres` from the host needs `sudo`.
- `data/.daemon.pid` — pidfile written by the daemon and consumed by `cli/stop.sh`.
- `data/.postgres-port` — chosen loopback host port that `ea-postgres` is published on (e.g. `5432`, or the next free port if 5432 was taken at startup). Read by anything host-side that wants to `psql` or use a `pg` client.

## Architecture

- **shared/**: TypeScript package (`effective-assistant-shared`) with types used by both host and container. Both sides depend on it via `"file:../shared"` in their package.json. Contains `ContainerParameters` (per-task IPC input file), `ContainerOutput` (per-task result file), and `TaskDefinition`. Must be built (`npm run build`) before host or container can compile. The Docker build handles this automatically.
- **host/**: Long-running Node.js daemon (entry: `host/src/daemon.ts`, started via `cli/start.sh`). Manages three singleton Docker containers: the bus-state postgres `ea-postgres`, the anthropic reverse proxy `ea-anthropic-proxy`, and the agent runtime `ea-agent`. All three join the shared bridge network `ea-net`. Postgres is published on `127.0.0.1:<port>:5432` only (port chosen at startup; written to `data/.postgres-port`). The daemon does not participate in per-task IPC — chat clients talk to the agent directly via `data/ipc/`.
- **host/src/db/**: Postgres lifecycle. `PostgresContainer` runs `postgres:16-alpine`, picks a free loopback port, joins `ea-net`, and waits for `pg_isready`. Hardcoded dev credentials: `POSTGRES_USER=ea`, `POSTGRES_PASSWORD=ea`, `POSTGRES_DB=ea`. Container code reaches the DB at `ea-postgres:5432`; host code at `127.0.0.1:<port>` (port from `data/.postgres-port`).
- **container/**: Docker container definition for the agent runtime. Long-running; built once, started by the host daemon and reused across all tasks.
  - Base image: `node:24-slim` with `@anthropic-ai/claude-agent-sdk` as a regular dependency.
  - `src/TaskLoop.ts` polls `/ipc/input/` for `{taskId}.json` files, processes them sequentially, and writes results to `/ipc/output/`. Sequential because the supervisor model has only one concurrent slot anyway.
  - Runs as non-root `node` user.
  - Docker build context is the project root (not `container/`), so `shared/` is available during image build.
- **proxy/**: Tiny Node HTTP reverse proxy. Reads `ANTHROPIC_API_KEY` from its env, forwards every request to `api.anthropic.com`, and overwrites the `x-api-key` header on the way through. Built into the `effective-anthropic-proxy` image. Stays as its own container for credential isolation; the agent container only sees the placeholder `ANTHROPIC_API_KEY=via-proxy`.

## Code Style

All TypeScript code is auto-formatted by [Biome](https://biomejs.dev/) on every edit (via a PostToolUse hook in `.claude/settings.json`). Do not manually adjust formatting.

### TypeScript Guidelines

- Document every function with a JSDoc comment: purpose, `@param`, `@returns`, and `@throws` where applicable.
- Use descriptive names — prefer `connectionTimeout` over `connTO`.
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

### Formatting & Linting

```bash
# From container/ or host/
npm run format        # Auto-format all source files
npm run format:check  # Check formatting without modifying (CI)
npm run lint          # Run linter
npm run check         # Format + lint combined
```
