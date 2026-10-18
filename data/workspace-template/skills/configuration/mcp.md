# mcp.yml recipes

`mcp_list` shows every MCP server in `mcp.yml` with its settings (secret env values masked) and a `status`: `active`, or `pending-add` / `pending-change` / `pending-remove` until you call `config_reload`.

## Entry shape

`mcp_add({ id, entry })` writes one complete entry; it does not search any registry, so you need the facts (image or package name, env vars) from the user or the server's documentation.

- `id`: lowercase letters and digits, starting with a letter (`github`, `fetch`, `time2`). It becomes the tool prefix (`github_create_issue`) and the tool group (`tools: github`). It must not equal a plugin id.
- `entry`:
  - `title`, `description` — short label and one sentence.
  - `source` and its location field:
    - `docker-mcp-registry` + `image` (e.g. `mcp/fetch`)
    - `npm` + `package` (+ optional `version`)
    - `pypi` + `package` (+ optional `version`)
    - `external` + `url` (a remote MCP over HTTP)
  - `env` (optional): `[{ name, value, is_secret?, description? }]`. Secret values (`is_secret: true`, or a name containing KEY/TOKEN/PASSWORD/SECRET) must be `""` — the result lists them under `secretsToEnter`.
  - `args` (optional): extra command-line arguments.
  - `network` (optional): `{ disable: true }` runs the server offline.
  - Tool gating (optional, globs over the server's bare tool names): `allowlist` (only these), `denylist` (hide these), `approval` (require approval), `privileged` (privileged runs only).

Example:

```json
{
  "id": "github",
  "entry": {
    "title": "GitHub",
    "description": "Issues, pull requests and repositories on GitHub.",
    "source": "docker-mcp-registry",
    "image": "mcp/github",
    "env": [{ "name": "GITHUB_PERSONAL_ACCESS_TOKEN", "value": "", "is_secret": true }],
    "privileged": ["create_*", "update_*", "delete_*", "merge_*"]
  }
}
```

## Workflow

1. `mcp_add` (or `mcp_set_env` / `mcp_remove` for existing servers).
2. If `secretsToEnter` is not empty: ask the user to put the values into `config/mcp.yml` (they edit the file directly; nobody pastes secrets into the chat).
3. `config_reload`. The report lists added / removed / changed servers.
4. In your next run the server's tools are available — check with `tool_list` (filter by the id). Errors while starting a server show up in `log_search` with `mcp: "<id>"`.

Changing anything in an entry (env, args, gating) restarts that one server on reload; the others keep running.
