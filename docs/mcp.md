# MCP servers

This document covers how the effective-assistant runtime brings up
[Model Context Protocol](https://modelcontextprotocol.io) servers as
docker containers and how to configure them via `config/mcp.yml`.

> **Status.** The runtime spins MCP containers up and down. The
> agent does **not** yet talk to them — wiring MCP tools into the
> agent loop is the follow-up step. This page describes the
> infrastructure that's in place today.

## What an MCP is, and why we run it as a container

An MCP server exposes tools (functions the model can call: search
GitHub, fetch a URL, read mail, etc.) over a standard protocol. We
run each MCP as a separate docker container on the shared `ea-net`
network so it can be added or removed without rebuilding the agent
image, and so per-MCP filesystem and network restrictions can be
applied at the container boundary.

## The four sources

Every entry in `config/mcp.yml` declares a `source`. The source
selects which factory builds the container.

| `source` | What it is | Status |
| --- | --- | --- |
| `docker-mcp-registry` | Image from the [Docker MCP registry](https://github.com/docker/mcp-registry) (e.g. `mcp/fetch`). The image is pulled and run as-is. | **Implemented.** |
| `npm` | npm package run inside a generic node container. Intended for MCPs distributed via npm without an official docker image. | Stub — declaring this source today fails fast at boot. |
| `pypi` | pypi package run inside a generic python container. Same idea as `npm`. | Stub. |
| `external` | Remote MCP reachable over HTTP. No container is started; the runner only stores the URL for the (future) agent tool layer to dial. | Stub — parses, but nothing yet consumes the URL. |

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

## Operations

- **Lint.** `./cli.sh mcp lint` validates `config/mcp.yml`. A
  missing file is treated as "no MCPs" and is not an error.
- **Listing live MCPs.** `docker ps --filter name=ea-mcp-` shows
  every running MCP container.
- **Logs.** The daemon does not yet stream individual MCP container
  logs into the host log file (only the agent's are streamed).
  Inspect them directly with `docker logs ea-mcp-<id>` for now.
- **Container naming.** Every MCP runs as `ea-mcp-<id>`. Ids must
  match `^[a-z0-9][a-z0-9-]*$`.

## Future

- A CLI helper that fetches a `server.yaml` URL from the Docker MCP
  registry and writes a translated entry into `mcp.yml`.
- Wiring MCPs into the agent's tool loop (transport selection: stdio
  via `docker exec`, or HTTP for sources that support it).
- Auth injection through the reverse proxy on outbound calls from
  MCP containers, so credentials never live in the container.
- `allowHosts` enforcement via an egress proxy.
- Real `npm`, `pypi`, and `external` factories.
- Streaming MCP container logs into the central host log stream.
