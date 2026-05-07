# MCP servers

This document covers how the effective-assistant runtime brings up
[Model Context Protocol](https://modelcontextprotocol.io) servers as
docker containers and how to configure them via `config/mcp.yml`.

> **Status.** End-to-end working. The host-side **bastion** brings
> stdio MCPs up on demand and forwards external HTTP MCPs. The agent
> consumes them through `@ai-sdk/mcp`: it fetches the bastion's
> catalog at boot, opens one client per declared MCP, and exposes
> their tools to handlers as `${id}_${toolName}`.

## What an MCP is, and how we run it

An MCP server exposes tools (functions the model can call: search
GitHub, fetch a URL, read mail, etc.) over a standard protocol. The
**bastion** — a host-side HTTP service the agent dials at
`${BASTION_URL}/mcp/<id>/...` — owns MCP lifecycle. For stdio-transport
MCPs the bastion spawns a foreground `docker run -i` child on first
request, multiplexes JSON-RPC over its stdin/stdout, and reaps the
child after the entry's `idleTimeoutSeconds` of inactivity. For HTTP /
external MCPs the bastion forwards the request to the upstream URL.
The agent never gains docker access or outbound internet.

## The four sources

Every entry in `config/mcp.yml` declares a `source`. The source
selects which factory builds the container.

| `source` | What it is | Status |
| --- | --- | --- |
| `docker-mcp-registry` | Image from the [Docker MCP registry](https://github.com/docker/mcp-registry) (e.g. `mcp/fetch`). The bastion spawns a foreground `docker run -i` child on demand. | **Implemented (stdio transport).** |
| `npm` | npm package run inside a generic node container. Intended for MCPs distributed via npm without an official docker image. | Stub — declaring this source today fails fast at gateway start. |
| `pypi` | pypi package run inside a generic python container. Same idea as `npm`. | Stub. |
| `external` | Remote MCP reachable over HTTP. No container is started; the bastion forwards the request to the configured URL. | **Implemented (HTTP forward).** |

## Adding an MCP by hand: `fetch` walkthrough

1. **Find the registry entry.** The Docker MCP registry hosts each
   server's `server.yaml` at a stable URL, e.g.
   `https://raw.githubusercontent.com/docker/mcp-registry/main/servers/fetch/server.yaml`.
   The `name` field becomes your MCP id; the `image` field becomes
   the value of the `image` key in your `mcp.yml`.
2. **Copy the example.** Start from `config/mcp.example.yml`:
   ```bash
   cp config/mcp.example.yml config/mcp.yml
   ```
   `mcp.yml` is gitignored.
3. **Edit `mcp.yml`.** The example already contains a working `fetch`
   entry. For other servers, add a new top-level key under `mcps:`
   and fill in `title`, `description`, `source: docker-mcp-registry`,
   and `image`.
4. **Lint.** `./cli.sh mcp lint` checks structure and required fields
   without starting anything.
5. **Restart the daemon.** `./cli.sh stop && ./cli.sh start`. Logs
   from `ea-mcp-<id>` flow into the host log stream the same way the
   agent's logs do.

## `mcp.yml` reference

Top-level shape: a YAML mapping of id → entry. The id (the YAML key)
must match `^[a-z0-9][a-z0-9-]*$` and is used as the container suffix
(`ea-mcp-<id>`).

### Per-entry fields

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `title` | string | yes | — | Short human-facing label for listings. |
| `description` | string | yes | — | Longer human-facing description. |
| `source` | enum | yes | — | One of `docker-mcp-registry`, `npm`, `pypi`, `external`. |
| `image` | string | yes when `source = docker-mcp-registry` | — | Docker image reference, e.g. `mcp/fetch`. |
| `package` | string | yes when `source = npm` or `pypi` | — | Package name on the registry. *(Stub today.)* |
| `version` | string | no | latest | Pin a `package` version. *(Stub today.)* |
| `url` | string | yes when `source = external` | — | Remote endpoint URL. *(Stub today.)* |
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

The `secrets` and `parameters` blocks from registry `server.yaml`
files are deliberately collapsed into this single `env` array so
that npm/pypi/external entries use the same shape.

### `network` block

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `disable` | boolean | `false` | When `true`, the container runs with `--network none`. |
| `allowHosts` | array of strings | `[]` | Allowed egress hosts (`host[:port]`, `*` wildcards). |

> **Enforcement caveat.** `allowHosts` is **parsed but not yet
> enforced** — it requires a sidecar egress proxy that is out of
> scope for the current runtime support. The lint warns when a
> non-empty `allowHosts` is set so the no-op behaviour is visible.
> `disable: true` is enforced today via `--network none`, but note
> that this also makes the container unreachable from the agent;
> useful for stdio-only MCPs only.

## How handlers use MCP tools

Each MCP tool is registered with the AI SDK as `${id}_${toolName}` —
the id (the YAML key in `mcp.yml`) and the tool's own name joined by
a single underscore. Our id regex bans underscores so the delimiter
is unambiguous. Examples:

```
fetch_fetch                        # mcp/fetch's only tool
atlassian_jira_create_issue        # one of mcp/atlassian's many
atlassian-personal_confluence_get_page
```

The agent boots the pool eagerly: every declared MCP gets its
`tools/list` fetched once at startup. Cold-spawn cost shows up here
(one docker child per MCP, briefly). That's fine for small catalogs;
when it isn't, the bastion will gain a tool-list cache that survives
child idle-reaps so this stays cheap.

## Filtering tools per handler

Handlers declare which MCP tools they want via a `tools:` expression
in their YAML header. **Omitted means none**: every handler opts in
explicitly, so a new MCP doesn't silently expand existing handlers'
surfaces. System tools (`send_chat`, `queue_run`, filesystem,
`get_weather`) are always present regardless.

### Expression grammar

```
expr     := or
or       := and ('||' and)*
and      := unary ('&&' unary)*
unary    := '!' unary | atom
atom     := group | path | '(' expr ')'
group    := IDENT                        e.g.  read-operations | all
path     := '/' SEGMENT ('/' SEGMENT)?   e.g.  /atlassian | /fetch/fetch
                                                /atlassian/jira_*
```

- Precedence: `!` > `&&` > `||`. Whitespace insignificant.
- `IDENT` is `[a-z][a-z0-9-]*` — group names.
- `SEGMENT` is `[a-zA-Z0-9_*-]+` — path segments. `*` is a glob
  wildcard inside a segment.
- `/<id>` ≡ `/<id>/*` — every tool on that MCP.
- The path's id must match the `mcp.yml` key **literally**: `/atlassian`
  matches the `atlassian` MCP only, not `atlassian-personal`.

### Built-in groups

- **`all`** — every MCP tool currently in the pool. The escape hatch
  for handlers that genuinely want everything: `tools: all`.

A `workspace/toolgroups/all.txt` is rejected; `all` is reserved.

### User groups

Plain-text files at `workspace/toolgroups/<name>.txt`, one entry per
line. Each line is either another group name (an `IDENT`) or a path
(starting with `/`). Lines are unioned; the group's tool set is the
collected matches.

```
# workspace/toolgroups/read-operations.txt
# Tools that fetch context without changing anything user-visible.

/atlassian/jira_get_*
/atlassian/jira_search
/atlassian/confluence_get_*
/fetch/fetch
```

`#` to end of line is a comment. Blank lines are ignored. The group
name comes from the filename stem and must match `IDENT`. Operators
(`&&`, `||`, `!`) inside group files are **not** allowed — composition
lives at the handler-expression level, where it's needed.

The whole `workspace/toolgroups/` directory is gated as
**privileged-write** regardless of file extension: handlers that
aren't descended from trusted user input (the cli-chat REPL or
operator chat) cannot create or modify group definitions.

### Worked examples

```yaml
---
tools: all                          # every MCP tool
---

---
tools: /fetch/fetch                 # one specific tool
---

---
tools: /atlassian/jira_*            # all Jira tools on the cloud Atlassian MCP
---

---
tools: read-operations              # a user-defined group
---

---
tools: read-operations || /atlassian/jira_create_issue
---
# union: every read tool, plus this one write tool

---
tools: read-operations && /atlassian
---
# intersection: read tools, narrowed to the atlassian MCP only

---
tools: all && !/atlassian-personal && !/atlassian/jira_delete_*
---
# everything, except the personal Atlassian instance and Jira delete tools
```

Resolution failures fail the agentrun loud, before the model is
invoked: an unknown group, a cycle in group references, or a syntax
error in the expression all surface as `agentrun failed` with the
underlying message in the row's `error` column.

## Operations

- **Lint.** `./cli.sh mcp lint` validates `config/mcp.yml`. A
  missing file is treated as "no MCPs" and is not an error.
- **Listing live MCPs.** `docker ps --filter name=ea-mcp-` shows
  every currently-spawned MCP child. Containers are **ephemeral**:
  they only exist while the bastion holds them open, and disappear
  after `idleTimeoutSeconds`.
- **Logs.** The bastion logs every spawn / idle-reap / crash event in
  the host log stream. To see an MCP child's own stdout/stderr while
  it is alive: `docker logs ea-mcp-<id>`.
- **Container naming.** Every MCP runs as `ea-mcp-<id>`. Ids must
  match `^[a-z0-9][a-z0-9-]*$`.
- **Multi-provider LLM URLs.** The bastion also handles
  `${BASTION_URL}/llm/<provider>/v1/*` for inference. Add more
  providers by adding their key under `inference.apiKeys.<provider>`
  in `config.yml`; common providers (featherless, groq, openai,
  anthropic, deepseek) ship with a built-in upstream URL, others
  need an `inference.baseUrls.<provider>` override.

## Future

- A CLI helper that fetches a `server.yaml` URL from the Docker MCP
  registry and writes a translated entry into `mcp.yml`.
- AI-assisted toolgroup authoring: a meta-handler that introspects
  the catalog and proposes groups (`read-operations`,
  `safe-jira-edits`, …) for the user to approve and write.
- Bastion-side filtering: today the gateway serves every tool to the
  agent and the container filters per handler. Pushing the filter to
  the gateway only matters once we don't fully trust the agent.
- Resources / prompts / elicitation surfaces from `@ai-sdk/mcp`
  (currently the pool only exposes `tools()`).
- SSE-streamed responses from the bastion for long-running tool
  calls (today plain JSON request/response is enough).
- Tool-list caching in the bastion that survives child idle-reaps,
  so agent boot stays cheap as the catalog grows.
- Auth injection through the bastion on outbound calls *from* MCP
  children (e.g. fetch hitting example.com).
- `allowHosts` enforcement via an egress proxy.
- Real `npm` and `pypi` factories.
