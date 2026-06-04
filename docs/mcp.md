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

The `command` field is honored for `npm` and `pypi` sources when the package's published
executable name differs from the package name. Setting `command: <bin>` switches the invocation to
`npx -y --package <pkg>[@<ver>] <bin>` / `uvx --from <pkg>[==<ver>] <bin>`; with `command` unset,
the simpler `npx -y <pkg>` / `uvx <pkg>` form runs (which assumes the entry-point name matches the
package name). `args` then act as the command's CLI args.

For `docker-mcp-registry` and `external` sources, `command` is currently ignored — those have no
CLI entrypoint to override. Use a custom image if you need to.

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
4. **Lint.** `./cli.sh tools lint-mcps` checks structure and required fields without starting anything.
5. **Restart the daemon.** `./cli.sh stop && ./cli.sh start`. Logs from `familiar-mcp-<id>` flow into
   the host log stream the same way the agent's logs do.

## `mcp.yml` reference

Top-level shape: a YAML mapping of id → entry. The id (the YAML key) must match
`^[a-z][a-z0-9]*$` (lowercase alphanumeric, leading letter, no hyphens or underscores) and is
used as the container suffix (`familiar-mcp-<id>`). The strict shape is required because every id
doubles as a tool group name — see "Built-in groups" below.

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
| `command` | string \| null | no | `null` | For `npm`/`pypi`: executable to run when it differs from the package name (switches to `--package` / `--from` form). Ignored for `docker-mcp-registry` and `external`. |
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

**Inside `tools:`, work with these sanitized — underscored — names only.** The hyphenated original
is never visible; tool-name hyphens are folded to `_` at registration time, and MCP ids are
constrained to alnum-only by the linter.

The agent boots the pool eagerly: every declared MCP gets its `tools/list` fetched once at
startup. Cold-spawn cost shows up here (one docker child per MCP, briefly). That's fine for small
catalogs; when it isn't, the bastion will gain a tool-list cache that survives child idle-reaps so
this stays cheap.

## Filtering tools per handler

Handlers declare which tools they want via a `tools:` list in their YAML header — a
comma-separated string or a YAML list. It selects across **all** registered tools — container
built-ins (`send_chat`, `schedule_handler`, `call_handler`, `unschedule_handler`,
`get_scheduled_handlers`, `fs_*`), plugin tools (`memory_*`, `ms365_*`, …) and namespaced MCP tools
share one available pool.

**Omitted ⇒ implicit `core`.** A handler with no `tools:` line — or an empty list / empty string —
gets every tool whose declared `groups` lists `core` (`send_chat`, `call_handler`,
`schedule_handler`, `unschedule_handler`, `fs_read`, plus opted-in plugin tools like
`memory_search` / `memory_save`). To expose nothing, use `tools: none`. Override with `tools: all`
or anything more specific.

### Entries

Each entry is one of three things, classified by shape — not by any surrounding syntax. Entries are
resolved independently and **unioned**; there are no operators, no precedence, and no parentheses.

- **Group name** — matches `^[a-z][a-z0-9]*$` (lowercase alnum, leading letter, no `_`, no `*`).
  Resolves to that group's tool keys; throws "unknown group" if undefined.
- **Explicit tool name** — a full namespaced key of the form `${id}_${name}` (e.g. `fetch_fetch`,
  `atlassian_jira_create_issue`). Use it verbatim — the same form the LLM sees in tool calls.
- **Tool glob** — a pattern containing `*`, matched against the pool's namespaced keys. `*` matches
  any character sequence (including `_`). Bare `*` matches every tool key.

The shape-based split is structurally unambiguous: tool keys always contain at least one `_` (the
id-name join), while group names cannot contain `_` at all. The `mcp.yml` linter rejects ids that
aren't alnum-only for the same reason — every id doubles as a group name.

Globs in a YAML list must be quoted (`"cal_*"`) because a leading `*` is a YAML alias indicator; in
a comma string they need no quoting (`core, cal_*`).

### Built-in groups

Three reserved names plus one auto-group per declared MCP / plugin id:

| Name | Resolves to |
| --- | --- |
| `all` | Every key in the available pool — container built-ins + plugin tools + MCP tools. |
| `mcp` | Just the namespaced MCP-tool keys. |
| `none` | Empty set. Lets a child handler override its parent's `tools:` to nothing under the replace-merge inheritance rule. |
| `<mcp-id>` | One auto-group per entry declared in `mcp.yml`. Resolves to every tool key that MCP exposes. So `tools: fetch` is shorthand for `tools: fetch_*`. |
| `<plugin-id>` | One auto-group per plugin that contributes tools. Resolves to every tool key the plugin registered. |

Curated names like `core`, `fs`, `reflection` are **not** reserved — they're populated by the
union of every tool whose declaration lists them. The container's built-ins join via a static
table in `ToolsFactory`; plugin tools join via `PluginTool.groups`. Coining a new group is a
matter of listing the name on one or more tools.

The three reserved names (`all`, `mcp`, `none`) are rejected as MCP ids by
`./cli.sh tools lint-mcps` and as plugin-tool group names by the host plugin tool registry, so a
name collision fails up front instead of being silently shadowed.

MCP ids are constrained to lowercase alphanumeric (no hyphens, no underscores) precisely because
they double as group names. An id like `myservice` becomes group `myservice`; ids like
`my-service` or `my_service` are rejected by the linter — pick `myservice` instead.

### Worked examples

```yaml
---
# (no `tools:` line)                        # implicit `core` — every tool whose
---                                         # `groups` lists `core`

---
tools: all                                  # every container + plugin + MCP tool
---

---
tools: none                                 # nothing at all (used by a child
---                                         # to override its parent's surface)

---
tools: core, fs                             # core defaults plus the fs bundle
---

---
tools: mcp                                  # all MCP tools, no other tools
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
tools: fetch, atlassian                     # union of two MCP-id auto-groups
---

---
tools:                                      # YAML-list form (globs quoted)
  - core
  - "cal_*"
  - at_jira_search
---
```

Resolution failures fail the agentrun loud, before the model is invoked: an unknown group surfaces
as `agentrun failed` with the underlying message in the row's `error` column.

A tool name or glob that matches **no** keys (e.g. a typo like `atlassian_jira_seerch`) is treated
as an empty contribution and the agentrun continues with whatever else the list selects. This
asymmetry is deliberate — wildcards routinely match nothing when a catalog evolves, and we don't
want every catalog change to break unrelated handlers.

## Operations

- **List every tool.** `./cli.sh tools list [search]` lists every tool the agent can use — container
  built-ins (`send_chat`, `fs_*`, `bash`, …), host plugin tools (`mail_*`, `whatsapp_*`, the
  reflection tools), and MCP functions — grouped by tool group. `-v` shows full descriptions, `-vv`
  adds each tool's parameters, `--mcp` / `--native` restrict to MCP-only or non-MCP-only, and `--raw`
  emits unstyled markdown. Requires the daemon: built-ins come from the catalog the agent container
  reports to the bastion on startup, plugin tools from the plugin-tools gateway, and MCP tools from
  the live bastion.
- **Lint.** `./cli.sh tools lint-mcps` validates `config/mcp.yml` and lists the configured MCPs (id,
  source, package). A missing file is treated as "no MCPs" and is not an error.
- **List declared MCPs.** `./cli.sh tools list-mcps` prints every entry in `mcp.yml`, its source, and
  whether the per-id container is `live` or `idle` right now (one `docker ps` shot at the start).
  For `npm`/`pypi` entries a `(cached)` annotation appears next to the package name when
  `tmp/mcp-mount-<id>/` already holds package files — useful to know *before* running `tools purge-mcps`.
  When the docker daemon is unreachable the command still prints the declared list and notes that
  live state couldn't be probed.
- **Purge cached package mounts.** `./cli.sh tools purge-mcps` removes every `tmp/mcp-mount-*` directory.
  **Refuses while the daemon is up** (a live `familiar-mcp-<id>` container could be reading from one);
  stop the daemon first with `./cli.sh stop`. Reports the number of directories removed and
  approximate bytes freed. `tmp/` itself is left in place so the daemon's next start doesn't fail
  on a missing parent.
- **Add a new MCP interactively.** `./cli.sh tools add-mcp <package>` searches the Docker MCP registry
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

- **One-shot CLI invocations.** `./cli.sh tools call-mcp <id> -- <args...>` runs a single foreground
  container with the entry's mount, env, `--user`, and network settings, but with the user's args
  appended after the package or image. Designed for out-of-band setup steps the bastion's normal
  stdio-server invocation can't reach — the canonical case is OAuth login flows that write a
  token under `$HOME` (= `/work`, = `tmp/mcp-mount-<id>/`), where the next bastion-spawned
  container picks the token up.

  The `--` is required: it tells citty's parser to stop and pass everything after verbatim, so
  flags like `--login` aren't interpreted as our own. Example:
  ```
  ./cli.sh tools call-mcp ms365 -- --login
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
