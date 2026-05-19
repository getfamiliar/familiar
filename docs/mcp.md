# MCP servers

This document covers how the Familiar runtime brings up
[Model Context Protocol](https://modelcontextprotocol.io) servers as docker containers and how to
configure them via `config/mcp.yml`.

> **Status.** End-to-end working. The host-side **bastion** brings stdio MCPs up on demand and
> forwards external HTTP MCPs. The agent consumes them through `@ai-sdk/mcp`: it fetches the
> bastion's catalog at boot, opens one client per declared MCP, and exposes their tools to handlers
> as `${id}_${toolName}`.

## What an MCP is, and how we run it

An MCP server exposes tools (functions the model can call: search GitHub, fetch a URL, read mail,
etc.) over a standard protocol. The **bastion** — a host-side HTTP service the agent dials at
`${BASTION_URL}/mcp/<id>/...` — owns MCP lifecycle. For stdio-transport MCPs the bastion spawns a
foreground `docker run -i` child on first request, multiplexes JSON-RPC over its stdin/stdout, and
reaps the child after the entry's `idleTimeoutSeconds` of inactivity. For HTTP / external MCPs the
bastion forwards the request to the upstream URL. The agent never gains docker access or outbound
internet.

## The four sources

Every entry in `config/mcp.yml` declares a `source`. The source selects which factory builds the
container.

| `source` | What it is | Status |
| --- | --- | --- |
| `docker-mcp-registry` | Image from the [Docker MCP registry](https://github.com/docker/mcp-registry) (e.g. `mcp/fetch`). The bastion spawns a foreground `docker run -i` child on demand. | **Implemented (stdio transport).** |
| `npm` | npm package run inside the shared `familiar-mcp-runtime-npm` image (entrypoint `npx -y`). For MCPs distributed via npm without an official docker image. | **Implemented (stdio transport).** |
| `pypi` | pypi package run inside the shared `familiar-mcp-runtime-pypi` image (entrypoint `uvx`). | **Implemented (stdio transport).** |
| `external` | Remote MCP reachable over HTTP. No container is started; the bastion forwards the request to the configured URL. | **Implemented (HTTP forward).** |

### npm and pypi runtime images

Both runtimes are built from `mcp-runtime/<source>/Dockerfile` on daemon start (only when `mcp.yml`
actually declares an entry of that source — no idle build cost). Each MCP gets a per-id host
directory `tmp/mcp-mount-<id>/` bind-mounted at `/work` inside the container; `/work` doubles as
`WORKDIR` and `HOME`, so npx's and uv's caches persist across cold-spawn cycles.

The runtime containers run with `--user <hostUid>:<hostGid>` matched to the daemon process, so
files written into `tmp/mcp-mount-<id>/` are owned by the operator, not root. The `tmp/` directory
itself is gitignored and safe to `rm -rf` whenever a clean slate is wanted; the next call refetches.

> **Footgun.** A `volumes:` entry that targets `/work` (or a subpath) overlays our mandatory
> mount — by docker semantics the last `-v` wins. We don't validate this; if a specific MCP needs
> to mount something else at `/work`, it's allowed.

The `command` field is **ignored** for npm/pypi sources. The entry point is fixed to `npx -y` /
`uvx` to keep the runtime contract predictable. Use `source: docker-mcp-registry` with a custom
image for anything else.

## Adding an MCP by hand: `fetch` walkthrough

1. **Find the registry entry.** The Docker MCP registry hosts each server's `server.yaml` at a
   stable URL, e.g.
   `https://raw.githubusercontent.com/docker/mcp-registry/main/servers/fetch/server.yaml`. The
   `name` field becomes your MCP id; the `image` field becomes the value of the `image` key in
   your `mcp.yml`.
2. **Copy the example.** Start from `config/mcp.example.yml`:
   ```bash
   cp config/mcp.example.yml config/mcp.yml
   ```
   `mcp.yml` is gitignored.
3. **Edit `mcp.yml`.** The example already contains a working `fetch` entry. For other servers,
   add a new top-level key under `mcps:` and fill in `title`, `description`,
   `source: docker-mcp-registry`, and `image`.
4. **Lint.** `./cli.sh mcp lint` checks structure and required fields without starting anything.
5. **Restart the daemon.** `./cli.sh stop && ./cli.sh start`. Logs from `familiar-mcp-<id>` flow into
   the host log stream the same way the agent's logs do.

## `mcp.yml` reference

Top-level shape: a YAML mapping of id → entry. The id (the YAML key) must match
`^[a-z][a-z0-9]*$` (lowercase alphanumeric, leading letter, no hyphens or underscores) and is
used as the container suffix (`familiar-mcp-<id>`). The strict shape is required because every id
doubles as a tools-DSL group name — see "Built-in groups" below.

### Per-entry fields

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `title` | string | yes | — | Short human-facing label for listings. |
| `description` | string | yes | — | Longer human-facing description. |
| `source` | enum | yes | — | One of `docker-mcp-registry`, `npm`, `pypi`, `external`. |
| `image` | string | yes when `source = docker-mcp-registry` | — | Docker image reference, e.g. `mcp/fetch`. |
| `package` | string | yes when `source = npm` or `pypi` | — | Package name on the registry (e.g. `@dangahagan/weather-mcp`, `mcp-server-time`). |
| `version` | string | no | latest | Pin a `package` version. Joined with `@` for npm and `==` for pypi. |
| `url` | string | yes when `source = external` | — | Remote endpoint URL. |
| `env` | array | no | `[]` | Environment variables; see below. |
| `volumes` | array of strings | no | `[]` | Bind mounts as `host:container[:ro]`. |
| `args` | array of strings | no | `[]` | CLI args appended after the image's `CMD`. |
| `command` | string \| null | no | `null` | When set, overrides the image's `ENTRYPOINT`. |
| `network` | mapping | no | see below | Network constraints. |
| `idleTimeoutSeconds` | positive integer | no | `1800` | Seconds of stdio inactivity after which the child is closed and reaped. Next request cold-spawns. Has no effect on HTTP / external transports. |

### `env` entries

Each element of the `env` array is a mapping with these fields:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes | Environment-variable name. |
| `value` | string | yes | The value injected into the container. |
| `is_secret` | boolean | no | Marks the value as sensitive. Drives log masking once that lands; informational today. |
| `example` | string | no | Placeholder shown by the (future) "add MCP" CLI. |
| `description` | string | no | Human-facing help string. |

The `secrets` and `parameters` blocks from registry `server.yaml` files are deliberately collapsed
into this single `env` array so that npm/pypi/external entries use the same shape.

### `network` block

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `disable` | boolean | `false` | When `true`, the container runs with `--network none`. |

Two states: online (default, joins `familiar-net`) or offline (`disable: true`). Hostname-level
allowlisting is deliberately not supported — docker has no native hostname-egress flag, and a
forward-proxy sidecar is more infrastructure than the runtime wants to own. `disable: true` also
makes the container unreachable from the agent's HTTP catalog calls; useful for stdio-only MCPs
only.

> **Two-phase boot for offline npm/pypi.** When an `npm` or `pypi` entry has `disable: true`,
> the bastion can't fetch the package from the run-phase container. On the first cold-spawn
> after daemon start it runs a **prep container** with full network access (`familiar-net`) and **no
> env vars / no user volumes**: `npx -y --package <pkg> -- node -e ""` for npm,
> `uvx --from <pkg> python -c ""` for pypi. The package lands in the bind-mounted `/work`
> cache; the phase-2 container then runs as declared (no network, env vars, volumes) and the
> warm cache lets `npx`/`uvx` skip the fetch. Prep needs network even when the running MCP
> doesn't — fully air-gapped installs aren't supported.
>
> Prep runs **only when the per-MCP mount dir is absent** (`tmp/mcp-mount-<id>/`). Once the
> package is cached, daemon restarts skip prep entirely — otherwise the package's install hooks
> would run with full network on every restart and could exfiltrate anything the offline phase-2
> run had stashed in `/work`. To re-run prep (after a package version bump or to recover from a
> poisoned cache), delete `tmp/mcp-mount-<id>/` and restart the daemon. If prep fails, the mount
> dir is wiped so the next start retries.

## How handlers use MCP tools

Each MCP tool is registered with the AI SDK as `${id}_${toolName}` — the id (the YAML key in
`mcp.yml`) and the tool's own name joined by a single underscore. **Every non-`[a-zA-Z0-9_]`
character in the final key is folded to `_`** so the result is safe for every model's
function-call grammar (some open-source LLMs — GLM 5.1, several Qwen variants — silently drop
tool calls whose names contain hyphens, and `finish_reason: "other"` falls out the other side
with no error).

Examples after sanitization:

```
fetch_fetch                            # mcp/fetch's only tool
atlassian_jira_create_issue            # one of mcp/atlassian's many
ms365_verify_login                     # `verify-login` tool → underscore
```

**Inside `tools:` expressions and toolgroup files, work with these sanitized — underscored — names
only.** The DSL never sees the hyphenated original; tool-name hyphens are folded to `_` at
registration time, MCP ids are constrained to alnum-only by the linter, so a hyphen inside an
expression is always the difference operator, never part of a name.

The agent boots the pool eagerly: every declared MCP gets its `tools/list` fetched once at
startup. Cold-spawn cost shows up here (one docker child per MCP, briefly). That's fine for small
catalogs; when it isn't, the bastion will gain a tool-list cache that survives child idle-reaps so
this stays cheap.

## Filtering tools per handler

Handlers declare which tools they want via a `tools:` expression in their YAML header. The
expression filters across **all** registered tools — system tools (`send_chat`, `queue_handler`,
`call_handler`, `file_*`, `fs_*`) and namespaced MCP tools share one available pool.

**Omitted ⇒ implicit `system`.** A handler with no `tools:` line gets every system tool registered
for the agentrun and no MCP tools, matching pre-filter behavior. Override with `tools: all`,
`tools: none`, or anything more specific.

### Expression grammar

```
expr      := plusMinus
plusMinus := and (('+' | '-') and)*
and       := atom ('&' atom)*
atom      := bareword | '(' expr ')'

bareword  := [a-zA-Z0-9_*]+
```

Operators:

- `a + b` — both `a` and `b` together (set union).
- `a - b` — `a` without the tools in `b` (set difference).
- `a & b` — tools in `a` and `b` both (set intersection).

Precedence: `&` binds tighter than `+`/`-`. `+` and `-` share one level and read left-to-right
(`a + b - c` = `(a + b) - c`, `all - x - y` = `(all - x) - y`). Parens override. Whitespace is
insignificant.

**Names use underscores only.** Tool keys are sanitized so a tool named `verify-login` from MCP
`ms365` registers as `ms365_verify_login`; MCP ids themselves are constrained to alnum-only by the
linter (no hyphens, no underscores), and toolgroup filenames must follow the same alnum-only
shape. `-` inside an expression is therefore always the difference operator, never part of a name.

Each bareword is **either a group name or a tool pattern** — classified by shape, not by syntax:

- Matches `^[a-z][a-z0-9]*$` (lowercase alnum, leading letter, no `_`, no `*`) → **group** lookup.
  Throws "unknown group" if undefined.
- Anything else (contains `_` or `*`, or has uppercase) → **tool pattern**, matched against the
  pool's namespaced keys.
- Tool keys have the form `${id}_${name}` (e.g. `fetch_fetch`, `atlassian_jira_create_issue`). Use
  them verbatim — the same form the LLM sees in tool calls.
- `*` is a glob wildcard matching any character sequence (including `_`). Bare `*` matches every
  tool key.

The shape-based split is structurally unambiguous: tool keys always contain at least one `_` (the
id-name join), while group names cannot contain `_` at all. The `mcp.yml` linter rejects ids that
aren't alnum-only for the same reason — every id doubles as a group name.

### Built-in groups

Four reserved names plus one auto-group per declared MCP are resolved by the evaluator before any
user lookup:

| Name | Resolves to |
| --- | --- |
| `all` | Every key in the available pool — system tools + MCP tools. |
| `system` | Just the system tools registered for *this* agentrun. Conditional ones (`send_chat` only when chat context is present, `queue_handler` / `call_handler` only when bus + parent are present, with `call_handler` additionally requiring the Scheduler's `waitForSubagent` hook) are reflected automatically. **The implicit default** when `tools:` is omitted. |
| `mcp` | Just the namespaced MCP-tool keys. Useful for `mcp - some_mcp_*` style scopes. |
| `none` | Empty set. Lets a child handler override its parent's `tools:` to nothing under the replace-merge inheritance rule. |
| `<mcp-id>` | One auto-group per entry declared in `mcp.yml`. Resolves to every tool key that MCP exposes. So `tools: fetch` is shorthand for `tools: fetch_*`, and `tools: all - atlassian` excludes every Atlassian tool without spelling out the prefix glob. |

The four reserved names (`all`, `system`, `mcp`, `none`) are shadowed if a workspace
`toolgroups/<name>.txt` exists — the resolver never reads those files. They are **also** rejected
as MCP ids by `./cli.sh mcp lint`, so an `mcp.yml` entry keyed `system:` fails up front instead of
being silently shadowed.

MCP ids are constrained to lowercase alphanumeric (no hyphens, no underscores) precisely because
they double as group names. An id like `myservice` becomes group `myservice`; ids like
`my-service` or `my_service` are rejected by the linter — pick `myservice` instead.

### User groups

Plain-text files at `workspace/toolgroups/<name>.txt`, one entry per line. Each line is either
another group name or a tool pattern — same classification rule as expressions. Lines are unioned;
the group's tool set is the collected matches.

```
# workspace/toolgroups/reads.txt
# Tools that fetch context without changing anything user-visible.

fetch_fetch
atlassian_jira_get_*
atlassian_jira_search
atlassian_confluence_get_*
```

`#` to end of line is a comment. Blank lines are ignored. The group's name comes from the filename
stem and must match `^[a-z][a-z0-9]*$` (the same alnum-only shape as MCP ids). Operators (`+`,
`-`, `&`) inside group files are **not** allowed — composition lives at the handler-expression
level, where it's needed.

The whole `workspace/toolgroups/` directory is gated as **privileged-write** regardless of file
extension: handlers that aren't descended from trusted user input (the cli-chat REPL or operator
chat) cannot create or modify group definitions.

**Group files are loaded lazily.** A given `<name>.txt` is only opened when an agentrun's
expression actually references that group; a malformed line in `workspace/toolgroups/foo.txt` only
fails the handlers that say `tools: foo`. Unrelated handlers run clean.

### Worked examples

```yaml
---
# (no `tools:` line)                        # implicit `system` — every system
---                                         # tool, no MCP tools

---
tools: all                                  # every system + MCP tool
---

---
tools: none                                 # nothing at all (used by a child
---                                         # to override its parent's surface)

---
tools: system - file_write                  # system tools, but no file_write
---                                         # (drop file_str_replace and
                                            #  file_append too for true read-only;
                                            #  use a group for ergonomics)

---
tools: mcp                                  # all MCP tools, no system tools
---

---
tools: fetch_fetch                          # one specific tool
---

---
tools: fetch                                # every tool on the `fetch` MCP
---                                         # (auto-group from mcp.yml id)

---
tools: atlassian_jira_*                     # all Jira tools on the atlassian MCP
---

---
tools: atlassian                            # every tool on the `atlassian` MCP
---                                         # (auto-group; equivalent to
                                            #  `atlassian_*`)

---
tools: reads                                # a user-defined group
---

---
tools: system + reads                       # system tools + user-defined reads
---

---
tools: fetch + atlassian                    # union of two MCP-id auto-groups
---

---
tools: all - atlassian - fetch              # everything except those two MCPs
---

---
tools: all - atlassian_jira_delete_*        # everything except Jira delete tools
---

---
tools: mcp & *_search                       # only MCP-tool keys ending in _search
---
```

Resolution failures fail the agentrun loud, before the model is invoked: an unknown group, a cycle
in group references, or a syntax error in the expression all surface as `agentrun failed` with the
underlying message in the row's `error` column.

A tool pattern that matches **no** keys (e.g. a typo like `atlassian_jira_seerch`) is treated as
an empty contribution and the agentrun continues with whatever else is in the expression. This
asymmetry is deliberate — wildcards routinely match nothing when a catalog evolves, and we don't
want every catalog change to break unrelated handlers.

## Operations

- **Lint.** `./cli.sh mcp lint` validates `config/mcp.yml`. A missing file is treated as "no MCPs"
  and is not an error.
- **List declared MCPs.** `./cli.sh mcp list` prints every entry in `mcp.yml`, its source, and
  whether the per-id container is `live` or `idle` right now (one `docker ps` shot at the start).
  For `npm`/`pypi` entries a `(cached)` annotation appears next to the package name when
  `tmp/mcp-mount-<id>/` already holds package files — useful to know *before* running `mcp purge`.
  When the docker daemon is unreachable the command still prints the declared list and notes that
  live state couldn't be probed.
- **Purge cached package mounts.** `./cli.sh mcp purge` removes every `tmp/mcp-mount-*` directory.
  **Refuses while the daemon is up** (a live `familiar-mcp-<id>` container could be reading from one);
  stop the daemon first with `./cli.sh stop`. Reports the number of directories removed and
  approximate bytes freed. `tmp/` itself is left in place so the daemon's next start doesn't fail
  on a missing parent.
- **Add a new MCP interactively.** `./cli.sh mcp add <package>` searches the Docker MCP registry
  first
  (`https://raw.githubusercontent.com/docker/mcp-registry/main/servers/<name>/server.yaml`), then
  falls back to the official MCP registry
  (`https://registry.modelcontextprotocol.io/v0.1/servers?search=…`). Walks the user through env
  vars (with the registry's description and example surfaced inline; secrets prompted via
  `password`), optional extra args, and the network setting; then shows a YAML preview and appends
  to `config/mcp.yml` on confirmation. Re-lints after writing so any structural problem surfaces
  immediately.

  The positional `<package>` is the **search term** for the registries (e.g. `fetch`,
  `mcp-server-time`, `io.github.foo/bar`). The local `mcp.yml` key is *derived* from the
  registry's canonical name and proposed as an editable default in the dialogue — the search term
  and the local id are intentionally distinct so reverse-DNS or scoped names don't bleed into
  your config.

  When a server is published as multiple package types (e.g. both an OCI image and an npm
  package), the dialogue lets you pick; OCI is labelled `(strongly preferred)` and selected by
  default. Registry types other than `oci`/`npm`/`pypi` (`nuget`, `mcpb`) are not supported and
  are dropped from the candidate list.

- **One-shot CLI invocations.** `./cli.sh mcp call <id> -- <args...>` runs a single foreground
  container with the entry's mount, env, `--user`, and network settings, but with the user's args
  appended after the package or image. Designed for out-of-band setup steps the bastion's normal
  stdio-server invocation can't reach — the canonical case is OAuth login flows that write a
  token under `$HOME` (= `/work`, = `tmp/mcp-mount-<id>/`), where the next bastion-spawned
  container picks the token up.

  The `--` is required: it tells citty's parser to stop and pass everything after verbatim, so
  flags like `--login` aren't interpreted as our own. Example:
  ```
  ./cli.sh mcp call ms365 -- --login
  ```
  No `--name` is set on the docker invocation, so the call won't collide with a bastion-managed
  `familiar-mcp-<id>` container that may be running concurrently. The exit status of the docker child is
  propagated to the calling shell. `external` sources are refused (no container to run).

- **Listing live MCPs directly.** `docker ps --filter name=familiar-mcp-` shows every currently-spawned
  MCP child. Containers are **ephemeral**: they only exist while the bastion holds them open, and
  disappear after `idleTimeoutSeconds`.
- **Logs.** The bastion logs every spawn / idle-reap / crash event in the host log stream. To see
  an MCP child's own stdout/stderr while it is alive: `docker logs familiar-mcp-<id>`.
- **Container naming.** Every MCP runs as `familiar-mcp-<id>`. Ids must match `^[a-z][a-z0-9]*$`.
- **Multi-provider LLM URLs.** The bastion also handles `${BASTION_URL}/llm/<provider>/v1/*` for
  inference. Add more providers by adding their key under `inference.apiKeys.<provider>` in
  `config.yml`; common providers (featherless, groq, openai, anthropic, deepseek) ship with a
  built-in upstream URL, others need an `inference.baseUrls.<provider>` override.

## Future

- A CLI helper that fetches a `server.yaml` URL from the Docker MCP registry and writes a
  translated entry into `mcp.yml`.
- AI-assisted toolgroup authoring: a meta-handler that introspects the catalog and proposes
  groups (`reads`, `safejiraedits`, …) for the user to approve and write.
- Bastion-side filtering: today the gateway serves every tool to the agent and the container
  filters per handler. Pushing the filter to the gateway only matters once we don't fully trust
  the agent.
- Resources / prompts / elicitation surfaces from `@ai-sdk/mcp` (currently the pool only exposes
  `tools()`).
- SSE-streamed responses from the bastion for long-running tool calls (today plain JSON
  request/response is enough).
- Tool-list caching in the bastion that survives child idle-reaps, so agent boot stays cheap as
  the catalog grows.
- Auth injection through the bastion on outbound calls *from* MCP children (e.g. fetch hitting
  example.com).
- Private npm / pypi registry support (registry config + auth injection through the runtime
  images).
