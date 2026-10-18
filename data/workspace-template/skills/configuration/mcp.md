# mcp.yml recipes

`mcp_list` shows every MCP server in `mcp.yml` with its settings (secret env values masked) and a `status`: `active`, or `pending-add` / `pending-change` / `pending-remove` until you call `config_reload`.

## Entry shape

`mcp_add({ id, entry })` writes one complete entry; it does not search any registry. Find a server with `mcp_registry_search({ query })` first: it lists the servers that fit this runtime with a 0–5 star security rating, the findings behind each rating, and the install facts (source, image/package/url, suggested id, required env vars). The search can take up to a minute (several registries, platform and popularity lookups) — in a chat, tell the user with `send_chat` that you are searching before you call it. Prefer the highest-rated candidate; explain the rating to the user from the findings, and before adding a `registry-only` server, look at its source repository and get the user's go-ahead.

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

1. `mcp_registry_search` to pick a server, then `mcp_add` (or `mcp_set_env` / `mcp_remove` for existing servers).
2. If `secretsToEnter` is not empty: ask the user to put the values into `config/mcp.yml` (they edit the file directly; nobody pastes secrets into the chat).
3. `config_reload`. The report lists added / removed / changed servers.
4. In your next run the server's tools are available — check with `tool_list` (filter by the id). Errors while starting a server show up in `log_search` with `mcp: "<id>"`.

Changing anything in an entry (env, args, gating) restarts that one server on reload; the others keep running.

## Running a setup command

Some servers need a one-time step outside the MCP protocol: a login (`--login`), an auth status check, a version probe. `mcp_execute_bash_command({ id, args })` runs the server's container once with `args` appended to its configured args — the same as the user running `familiar tools call-mcp <id> -- <args>`. It works right after `mcp_add`, before `config_reload`. Each array item is one argument; there is no shell.

- If the result says `running: true`, the command is waiting, typically for the user to complete a device-code login. Relay the code and URL from `output` to the user (`send_chat`), then call `mcp_execute_bash_command({ callId, waitSeconds: 120 })` until `running` is false. Use `{ callId, stop: true }` to abort.
- `output` has every configured secret replaced by `***`. Never ask the user to reveal it.

