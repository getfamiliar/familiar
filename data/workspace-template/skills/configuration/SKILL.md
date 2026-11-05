---
name: configuration
description: Change Familiar's own configuration (config.yml settings, plugins, MCP servers) with the user, apply it without a daemon restart, and give the user access to the web interface.
tools: config_reload
---

# Changing the configuration

Familiar's settings live in two host-side files you cannot open directly: `config/config.yml` (platform, models, plugins) and `config/mcp.yml` (MCP servers). You change them through the `config_*` and `mcp_*` tools (tool group `config`, privileged runs only). Discover them with `tool_list` when they are not loaded.

Always work in this order:

1. **Read first.** Look at the current state (`config_get` / `mcp_list`) before proposing a change. Never guess key names — check `config_get` output or the recipes below.
2. **Agree on the change** with the user when it is not exactly what they asked for.
3. **Edit.** `config_set` / `config_unset` / `mcp_add` / `mcp_remove` / `mcp_set_env`. Edits only change the file; batch related edits.
4. **Apply** with `config_reload`. It validates everything first and applies nothing on errors — then fix the reported problem and reload again.
5. **Report** the outcome in plain words: what is active now, what still needs a daemon restart (`familiar stop && familiar start`), which plugins restarted, which MCP servers changed. New tools and settings take effect from the next run on, not in the current one.

## Secrets

API keys, tokens and passwords never go through you. Every key or env var whose name contains `key`, `token`, `password` or `secret` is masked when you read it (`"***set***"` when configured, `null` when empty) and the tools refuse to write it.

- Never ask the user to paste a secret into the chat. If they do anyway, do not repeat it, do not store it anywhere, and tell them to rotate it.
- When a secret is needed, tell the user the exact key (e.g. `telegram.botToken`, or env `GITHUB_TOKEN` of MCP `github`) and ask them to enter it with `familiar config set <key>` in a terminal (hidden prompt) or by editing the file — then call `config_reload`.
- `config_get` tells you whether a secret is set; that is all you need to know.

## Recipes

- Settings in `config.yml` (models, mail/calendar safety, chat, plugins): read `skills/configuration/config.md`.
- Web interface access (the user asks for a login link or how to reach the web UI; `web_login_link`, `webserver.*` settings, LAN / Tailscale addresses): read `skills/configuration/web-interface.md`.
- MCP servers in `mcp.yml` (add, remove, env vars, tool gating, where a server keeps its login): read `skills/configuration/mcp.md`. To add a server, follow its "Adding a server" steps: purpose first, then `mcp_registry_search` / `mcp_registry_details`, fit check and tool-gating proposal before `mcp_add`.
