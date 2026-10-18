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
4. **Lint.** `familiar tools lint-mcps` checks structure and required fields without starting anything.
5. **Restart the daemon.** `familiar stop && familiar start`. Logs from `familiar-mcp-<id>` flow into
   the host log stream the same way the agent's logs do.

## Searching the registries

`familiar tools search-mcp <term…>` and the agent tool `mcp_registry_search` run the same search (`host/src/mcp/registry-search/`) and produce the same markdown. All words of the term must match.

**Sources.** The Docker MCP catalog (`https://desktop.docker.com/mcp/catalog/v3/catalog.yaml`, the file Docker's MCP Toolkit reads; it carries pulls, GitHub stars and owner per entry; cached in-process for an hour) is matched against key, title, description and tags. The official MCP registry (`/v0.1/servers?search=…&version=latest`) is matched against name (minus the `io.github.` prefix), title and description; its server-side search is a substring match on the full name, so a broad term (`github`) hits thousands of `io.github.*` names. When that search is cut after 500 servers, two targeted searches (`/<term>`, `<term>/`) follow so names that start with the term aren't lost — these are slow on the registry side (~30 s) and best effort.

**Filtered out** (counted below the table; `-v` / `verbose: true` lists them with the reason):

- Packages other than `oci` / `npm` / `pypi`, packages serving a non-stdio transport, packages from a non-default npm/PyPI registry, and Docker `poci` entries.
- Remotes that need request headers, an OAuth login, URL template variables, or speak only legacy SSE — `external` forwards to a plain URL and the agent speaks Streamable HTTP.
- Official servers with lifecycle status `deprecated` or `deleted`.
- Images without a variant for the docker engine's platform (`docker version` → e.g. `linux/arm64`). Docker Hub images are checked through the Hub API (manifest GETs would count against the anonymous pull limit), other registries through the OCI distribution API with an anonymous token. A failed lookup keeps the candidate with a note. For official servers the next install variant (preference image → npm → pypi → remote) is tried before the server is dropped.
- Official servers whose source repository is also a Docker catalog entry — the catalog entry has the stronger provenance.

**Security rating (0–5 stars).** Every finding below the table names its star effect, so the agent can argue the rating:

1. *Provenance tier* sets the base. `docker-built` (image `mcp/<name>`, built and signed by Docker with provenance and SBOM) is a fixed 5/5 regardless of other signals. `docker-community-image` (catalog entry, image pushed by the publisher) and `docker-remote` (catalog entry pointing at a hosted endpoint) start at 3. `registry-only` starts at 1 and always needs further investigation — the registry verifies the namespace, not the code.
2. *Publisher identity.* The reverse-DNS name encodes what the registry verified: `io.github.<user>/…` a GitHub login, `com.vendor/…` DNS ownership of `vendor.com`. When the publisher (or, for catalog entries, the owner, image namespace or endpoint domain) is the vendor of the targeted service — the search term when it names the entry, else the entry's own name — the entry is *first party*: +2 for registry-only (+1 for a partial name match, "likely"), +1 for Docker community/remote entries. A community image pushed under the upstream repository owner's namespace gets another +1. A repository owned by someone other than the publisher, and a remote on the publisher's own domain, are reported as context.
3. *Popularity* (GitHub stars, Docker pulls, npm/PyPI downloads last month) is a weak signal: −1 when every known number is low (< 25 stars, < 1,000 pulls, < 200 downloads), +1 when one is high (≥ 1,000 stars, ≥ 100k pulls, ≥ 50k downloads) and none is low. GitHub stars come from the unauthenticated API (60 requests/hour, cached per process) and are only fetched for the head of the ranking; a rate-limited lookup shows up as a note.

Ratings other than `docker-built` are clamped to 0–4. The findings also list the install facts for `mcp_add`: source, image/package/url, a suggested id, and required env vars.

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
| `allowlist` | array of strings | no | `[]` | Bare tool-name globs; if non-empty, only matching tools are exposed. See "Gating MCP tools". |
| `denylist` | array of strings | no | `[]` | Bare tool-name globs; matching tools are hidden (removed from the allowlist survivors). |
| `approval` | array of strings | no | `[]` | Bare tool-name globs; matching tools get security level `approval`. |
| `privileged` | array of strings | no | `[]` | Bare tool-name globs; matching tools get security level `privileged` (wins over `approval` on overlap). |
| `idleTimeoutSeconds` | positive integer | no | `1800` | Seconds of stdio inactivity after which the child is closed and reaped. Next request cold-spawns. Has no effect on HTTP / external transports. |

### `env` entries

Each element of the `env` array is a mapping with these fields:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | string | yes | Environment-variable name. |
| `value` | string | yes | The value injected into the container. |
| `is_secret` | boolean | no | Marks the value as sensitive: the agent's `mcp_*` tools mask it and refuse to write it (names containing `KEY`/`TOKEN`/`PASSWORD`/`SECRET` count as secret anyway). `mcp_execute_bash_command` masks the value in command output; log masking is not implemented yet. |
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
> Prep runs **only when the per-MCP mount dir is empty** (`tmp/mcp-mount-<id>/`). Once the package is cached, daemon restarts skip prep entirely — otherwise the package's install hooks would run with full network on every restart and could exfiltrate anything the offline phase-2 run had stashed in `/work`. A successful prep records a stamp next to the mount dir (`tmp/mcp-mount-<id>.prep.json`, outside `/work` so the MCP can't forge it) with the package, version, `command` and runtime image id. When any of them changes — a version bump in `mcp.yml`, or a rebuilt runtime image whose package manager uses a new cache layout (uv 0.12 reads `simple-v25/`, older caches only have `simple-v21/`) — the next start wipes the mount dir and preps afresh; it never re-preps in place. This applies only to `network.disable: true` entries, which can't hold login state anyway; online MCPs' mount dirs (e.g. totem's tokens) are never wiped. To force a re-prep (e.g. a poisoned cache), delete `tmp/mcp-mount-<id>/` and restart the daemon. If prep fails, the mount dir is wiped so the next start retries.

## Reloading `mcp.yml`

`mcp.yml` is parsed at daemon start and again on every config reload — `familiar config reload` from the shell or the privileged agent tool `config_reload` (both also reload `config.yml`, see `docs/config.md`). There is no file watcher: a half-edited file is never applied. A reload:

1. **Validates first.** The whole file is linted, and an id that would collide with a plugin's tool group is refused. On any error nothing is applied and the daemon keeps the previous entries.
2. **Diffs by id.** An entry counts as *changed* when any of its fields differ (env, args, gating, version, …).
3. **Applies the diff in the gateway.** Removed and changed ids get their transport stopped (`familiar-mcp-<id>` is removed), changed and added ids get a fresh transport, and unchanged ids keep theirs. A request still in flight on a replaced transport is cut off; during the swap the affected ids answer 404. Newly referenced npm/pypi runtime images are built on demand.
4. **Resyncs the clients.** Host-side plugin MCP sessions of removed and changed ids are dropped and reconnect on their next call. Every catalog entry carries a `generation` that changes whenever its transport is rebuilt; the agent container checks the catalog at the start of every agentrun and reconnects only ids whose generation changed (a fresh stdio child has not seen the old session's `initialize`). An id that failed to connect is retried only after its generation changes.

Runs already in progress keep the tool set they started with; new tools appear from the next agentrun on.

### Agent tools

Any run can search the registries with `mcp_registry_search` (level `default`, tool group `config`) — the same search and markdown as `familiar tools search-mcp`, see "Searching the registries" below. Privileged runs can edit `mcp.yml` themselves (tool group `config`): `mcp_list` (entries as on disk, secret env values masked, with `pending-add` / `pending-change` / `pending-remove` status), `mcp_add` (writes one complete entry; it does not search any registry — use `mcp_registry_search` first), `mcp_remove`, and `mcp_set_env` (sets or adds one env var). None of them applies anything — the agent calls `config_reload` after its edits.

`mcp_execute_bash_command` (privileged, group `config`) is the agent's `familiar tools call-mcp`: `{id, args}` runs the entry's container one-shot (same image, env, mounts and mcp.yml `args:`, read from the file as on disk, so it works before `config_reload`) with `args` appended — no shell, one array item per argument. It returns `{callId, running, exitCode, output, outputTruncated, timedOut}`, where `output` is stdout+stderr new since the last read. A command that is still running after `waitSeconds` (default 20, max 120) returns its output so far and keeps running — the case of a device-code login waiting for the user. The agent then polls with `{callId}` or kills it with `{callId, stop: true}`. The container is named `familiar-mcp-exec-<id>-<callId>`, is killed after 15 minutes and on daemon shutdown, and output beyond 1 MB that nobody has read is dropped from the front (`outputTruncated`). **Every configured secret value is masked in the output** (`***`): all `config.yml` values at or below a secret key and all secret `mcp.yml` env values, including their URL-encoded and JSON-escaped forms; values shorter than 4 characters are left alone. The secrets are read fresh on every poll, and while the command runs, a possible secret prefix at the end of the output is held back until the next read.

**Secrets never pass through the agent.** An env var is a secret when it has `is_secret: true` or its name contains `KEY`, `TOKEN`, `PASSWORD` or `SECRET` (case-insensitive). `mcp_list` masks such values (`"***set***"` / `null`), `mcp_add` only accepts them empty and reports them as still to be entered, and `mcp_set_env` refuses them. The user enters secret values directly (by editing `mcp.yml`, or later through a dedicated secret prompt).

## How handlers use MCP tools

Each MCP tool is registered with the AI SDK as `${id}_${toolName}` — the id (the YAML key in
`mcp.yml`) and the tool's own name joined by a single underscore, both **verbatim**. Tool names
pass through unchanged, including any hyphens; hyphens are valid in the OpenAI / Anthropic
function-name grammar, and the AI SDK routes each call by its registered key, so no rewriting is
needed.

Examples:

```
fetch_fetch                            # mcp/fetch's only tool
atlassian_jira_create_issue            # one of mcp/atlassian's many
ms365_verify-login                     # hyphen preserved
```

Only the `${id}_` prefix is synthetic — it keeps tools from different MCPs distinct. The part after
it is exactly what the server calls the tool, which matters for the `mcp.yml` gating globs (see
"Gating MCP tools" — they match the **bare** server name, not the prefixed key). MCP ids are
constrained to alnum-only by the linter, so the first `_` after the id is an unambiguous delimiter.

The agent boots the pool eagerly: every declared MCP gets its `tools/list` fetched once at
startup. Cold-spawn cost shows up here (one docker child per MCP, briefly). That's fine for small
catalogs; when it isn't, the bastion will gain a tool-list cache that survives child idle-reaps so
this stays cheap.

## How handlers get tools: discovery and preloading

**Every handler run can reach every tool.** The `tools:` header no longer restricts a handler to a
fixed set — it's a *preload hint*. Two always-present meta-tools let the agent find and call
anything in the shared pool (container built-ins + plugin tools + every MCP's tools):

- **`tool_list`** — searches the full pool by substring; returns each match's `name`, security
  `level`, and whether it's already loaded into the toolset.
- **`tool_call`** — invokes any tool by name, including ones not preloaded.

On top of that, a **usage heuristic** auto-preloads the tools a handler has successfully used across
its recent non-error runs (bounded by a token budget, tuned by `core.toolDefinitionsContextFraction`
and `core.toolHeuristicRunWindow` in `config.yml`), so a warm handler rarely needs a
`tool_list`/`tool_call` round-trip. Every tool call is recorded to the `tool_calls` table to feed
this; an hourly GC keeps the last 200 rows per handler.

Discovery does not bypass security: a discovered `approval`/`privileged` tool still refuses to run
in a non-privileged run (see "Tool security levels"), and MCP `denylist` tools are never surfaced at
all.

### The `tools:` preload list

`tools:` declares the tools **guaranteed to be loaded up front** — a comma-separated string or a
YAML list. Use it to prime a handler toward the right tools and to make the first runs (before the
heuristic has any history) fast. It selects across the same shared pool.

**Omitted ⇒ implicit `core`.** A handler with no `tools:` line — or an empty list / empty string —
preloads every tool whose declared `groups` lists `core` (`send_chat`, `start_subagent`,
`schedule_subagent`, `unschedule_subagent`, `fs_read`, plus opted-in plugin tools like
`memory_search` / `memory_save`). `tools: none` preloads nothing — but the agent can still reach
tools through `tool_list`/`tool_call`. `tools: all` preloads the entire pool. The entry syntax below
is unchanged.

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
| `none` | Empty set. Preloads no tools at all (an omitted `tools:` means the implicit `core` default). |
| `<mcp-id>` | One auto-group per entry declared in `mcp.yml`. Resolves to every tool key that MCP exposes. So `tools: fetch` is shorthand for `tools: fetch_*`. |
| `<plugin-id>` | One auto-group per plugin that contributes tools. Resolves to every tool key the plugin registered. |

Curated names like `core`, `fs`, `reflection` are **not** reserved — they're populated by the
union of every tool whose declaration lists them. The container's built-ins join via a static
table in `ToolsFactory`; plugin tools join via `PluginTool.groups`. Coining a new group is a
matter of listing the name on one or more tools.

The three reserved names (`all`, `mcp`, `none`) are rejected as MCP ids by
`familiar tools lint-mcps` and as plugin-tool group names by the host plugin tool registry, so a
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
tools: all                                  # preload every container + plugin + MCP tool
---

---
tools: none                                 # preload nothing (the agent can still reach
---                                         # tools via tool_list / tool_call)

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

## Tool security levels

Every tool carries a security **level** that gates who may *run* it — independent of discovery. A
tool can be listed and visible yet still refuse to execute:

| Level | Who can run it |
| --- | --- |
| `default` | Anyone. Read-only or low-risk tools. |
| `approval` | Meant to require explicit user approval. The approval gate is not built yet; **until it is, `approval` behaves like `privileged`** — refused in non-privileged runs. |
| `privileged` | Only **privileged** runs — those descending from trusted user input (the cli-chat REPL, an allowlisted Telegram sender). |

A non-privileged run that calls an `approval`/`privileged` tool gets a `PrivilegeDenied` tool error
explaining why; the tool stays visible in `tool_list`. Container built-in and plugin tool levels are
set in code (e.g. `mail_send_*` = `approval`); **MCP tool levels come from `mcp.yml`** (next
section). `tool_list` reports each tool's level, and `familiar tools list` badges the non-`default`
ones.

## Gating MCP tools: `allowlist` / `denylist` / `approval` / `privileged`

Because every handler can reach every tool, `mcp.yml` gives per-MCP control over **which** of an
MCP's tools are exposed and **what level** each carries. Four optional keys under an MCP entry, each
a list of **bare tool-name globs** — the name the server uses (`jira_create_issue`), not the
namespaced `atlassian_jira_create_issue` key. They apply **in this order**:

1. **`allowlist`** — if present, only tools matching one of its globs survive. Omitted/empty ⇒ every
   tool allowed.
2. **`denylist`** — drop any survivor that matches. Dropped tools are **invisible**: not in
   `tool_list`, not callable via `tool_call`, not resolvable by any `tools:` entry or group.
3. **`approval`** — surviving tools that match are assigned level `approval`.
4. **`privileged`** — surviving tools that match are assigned level `privileged`. Evaluated last, so
   a tool matching both `approval` and `privileged` ends up `privileged`.

Glob semantics match the `tools:` matcher: a bare name is an exact match; `*` matches any sequence
(including `_`), fully anchored (`comment_*` matches `comment_reply` but not `commentary`). Some servers prefix their own tool names (totem reports `whoop_profile_update`), so check the bare names with `familiar tools list --mcp` — `familiar tools lint-mcps` warns about patterns that match no tool while the daemon is running.

The config lives host-side in `mcp.yml`; the `/mcp/` catalog ships the four lists verbatim and the container resolves them. A change applies with `familiar config reload` (or the agent's `config_reload` tool) — see "Reloading `mcp.yml`" below. `familiar tools list` applies the same gating so the operator sees exactly the agent's surface.

```yaml
atlassian:
  title: "Atlassian"
  description: "Jira + Confluence."
  source: external
  url: https://mcp.atlassian.example/
  allowlist: ["jira_*", "confluence_search"]   # expose only Jira tools + one Confluence tool
  denylist: ["jira_delete_*"]                  # …but never the delete tools
  approval: ["jira_create_issue"]              # creating an issue needs approval
  privileged: ["jira_admin_*"]                 # admin tools: privileged runs only
```

## Operations

- **Reload.** `familiar config reload` applies `config/mcp.yml` (together with `config/config.yml`) to the running daemon — see "Reloading `mcp.yml`" below.
- **List every tool.** `familiar tools list [search]` lists every tool the agent can use — container
  built-ins (`send_chat`, `fs_*`, `bash`, …), host plugin tools (`mail_*`, `whatsapp_*`, the
  reflection tools), and MCP functions — grouped by tool group. Non-`default` tools are badged
  (`[approval]` / `[privileged]`), and MCP `allowlist`/`denylist` gating is reflected (denied tools
  don't appear), so the listing matches the agent's actual surface. Note this is an operator
  inventory, not an agentrun: it has no `privileged` context, so it *shows* every level rather than
  hiding what a given run couldn't execute. `-v` shows full descriptions, `-vv` adds each tool's
  parameters, `--mcp` / `--native` restrict to MCP-only or non-MCP-only, and `--raw` emits unstyled
  markdown. Requires the daemon: built-ins come from the catalog the agent container reports to the
  bastion on startup, plugin tools from the plugin-tools gateway, and MCP tools from the live bastion.
- **Lint.** `familiar tools lint-mcps` validates `config/mcp.yml` and lists the configured MCPs (id,
  source, package). A missing file is treated as "no MCPs" and is not an error. When the daemon is
  running, it also lists each gated MCP's tools through the bastion and warns about every
  `allowlist` / `denylist` / `approval` / `privileged` pattern that matches no tool — such a pattern
  is a silent no-op at runtime. The warning suggests tool names that end with the pattern, which
  catches the common miss of a server prefixing its own tool names (totem reports
  `whoop_profile_update`, so `profile_update` matches nothing). Without the daemon the check is
  skipped with a note. `--raw` emits unstyled markdown.
- **List declared MCPs.** `familiar tools list-mcps` prints every entry in `mcp.yml`, its source, and
  whether the per-id container is `live` or `idle` right now (one `docker ps` shot at the start).
  For `npm`/`pypi` entries a `(cached)` annotation appears next to the package name when
  `tmp/mcp-mount-<id>/` already holds package files — useful to know *before* running `tools purge-mcps`.
  When the docker daemon is unreachable the command still prints the declared list and notes that
  live state couldn't be probed.
- **Purge cached package mounts.** `familiar tools purge-mcps` removes every `tmp/mcp-mount-*` directory.
  **Refuses while the daemon is up** (a live `familiar-mcp-<id>` container could be reading from one);
  stop the daemon first with `familiar stop`. Reports the number of directories removed and
  approximate bytes freed. `tmp/` itself is left in place so the daemon's next start doesn't fail
  on a missing parent.
- **Search the registries.** `familiar tools search-mcp <term…>` searches the Docker MCP catalog and the official MCP registry and prints the servers that fit this runtime as a security-rated table, followed by the findings behind every rating — see "Searching the registries" below. `-v` also lists the filtered-out servers with their reasons, `--limit <n>` changes the row count (default 20), `--platform <os/arch>` checks images against another platform, `--raw` emits unstyled markdown. Works without the daemon.
- **Add a new MCP interactively.** `familiar tools add-mcp <package>` searches the Docker MCP registry
  first
  (`https://raw.githubusercontent.com/docker/mcp-registry/main/servers/<name>/server.yaml`), then
  falls back to the official MCP registry
  (`https://registry.modelcontextprotocol.io/v0.1/servers?search=…`). Walks the user through env
  vars (with the registry's description and example surfaced inline; secrets prompted via
  `password`), optional extra args, and the network setting; then shows a YAML preview and appends
  to `config/mcp.yml` on confirmation. Re-lints after writing so any structural problem surfaces
  immediately, then offers to reload the running daemon so the new MCP starts right away.

  The positional `<package>` is the **search term** for the registries (e.g. `fetch`,
  `mcp-server-time`, `io.github.foo/bar`). The local `mcp.yml` key is *derived* from the
  registry's canonical name and proposed as an editable default in the dialogue — the search term
  and the local id are intentionally distinct so reverse-DNS or scoped names don't bleed into
  your config.

  When a server is published as multiple package types (e.g. both an OCI image and an npm
  package), the dialogue lets you pick; OCI is labelled `(strongly preferred)` and selected by
  default. Registry types other than `oci`/`npm`/`pypi` (`nuget`, `mcpb`) are not supported and
  are dropped from the candidate list.

- **One-shot CLI invocations.** `familiar tools call-mcp <id> -- <args...>` runs a single foreground
  container with the entry's mount, env, `--user`, and network settings, but with the user's args
  appended after the package or image. Designed for out-of-band setup steps the bastion's normal
  stdio-server invocation can't reach — the canonical case is OAuth login flows that write a
  token under `$HOME` (= `/work`, = `tmp/mcp-mount-<id>/`), where the next bastion-spawned
  container picks the token up.

  The `--` is required: it tells citty's parser to stop and pass everything after verbatim, so
  flags like `--login` aren't interpreted as our own. Example:
  ```
  familiar tools call-mcp ms365 -- --login
  ```
  No `--name` is set on the docker invocation, so the call won't collide with a bastion-managed
  `familiar-mcp-<id>` container that may be running concurrently. The exit status of the docker child is
  propagated to the calling shell. `external` sources are refused (no container to run). The agent's
  counterpart is `mcp_execute_bash_command` (see "Agent tools").

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
- The **approval gate**: `approval`-level tools currently fall back to `privileged` (refused in
  non-privileged runs). A real flow — pause the run, prompt the user, resume on approval — is
  planned; when it lands, `approval` graduates from "privileged-only" to "ask the user".
- Host-side (gateway) enforcement of MCP `allowlist`/`denylist`: today the gateway serves every tool
  and the container applies the `mcp.yml` gating. Moving allow/deny into the gateway (so a denied
  tool never crosses to the container) only matters once we don't fully trust the agent — the real
  security boundary (credential injection, `privileged`-run refusal, OS sandbox) already lives
  host/OS-side, and the container filter only controls visibility.
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
