

Features:
* Wakeups / Alerts per Datenbank bauen
* Compression
* Calendar Plugin - kompletter rewrite des mail plugins 
* True bash
* Besseres Reporting Format
* Self-Reflection Tools: List of events, event report, plugin status, system status 
* Tool Call Offloading in temp files


Reflect and learn from things when memory plugin is ready:
* Mail Digest
* ...



Neues CLI Tool: `logs`
* `logs tail` tails the current data/logs/ log file but pretty prints the JSON objects in it.

MCP functions: keep or remove the renaming of "-"?

## Refactoring

* cli.sh replacen mit `npx familiar`, die prechecks über den npm hook prepublishOnly laufen lassen. Gleichheit zwischen dev und prod sicherstellen.

## For later

- MS365: Enable / Disable Out of Office Notes
- Protect the bastion port on the host? Maybe a simple basic auth?
- Spotify MCP based on https://github.com/aome510/spotify-player
- Alternativen Modellprovider testen: Synthetic.new - wie Featherless, 30€ / Monat, scheinbar zuverlässiger

## Workspace Linter

- No unexpected .md files in the root
- Check reserved group names in toolgroups/: "all", "none", "system", mcp group ids
- Check the tools in the tool groups for existence
- Parse the tools frontmatter statements and check if they are valid (existing tools and groups and parseable)
- Parse all cron expressions to check if valid
- Count tools per handler and warn if there are too many
Extreme:
- Check handler files for tool name mentions that do not exist

## Before release

- The whole schema contains migrations at the moment, pull a blank slate

## Security Holes

## Setup process

- check:
  - node
  - npm
  - docker
  - npm i
  - npm run build --workspaces --if-present (attention: does not resolve the order of dependencies, trying to build telegram before whisper etc. - AST based dependency resolution would be nice)
  - Use node-linux or node-mac packages to create a native service

Important: many services need a restart after login (whatsapp, o365, ...). Request that?

## Marketing Speak

* Ralph Loop for loosing context vs what we do with different handler files
* Interesting: [statewright](https://github.com/statewright/statewright) implements narrowed down scopes for agents in certain steps, quite similar to our handler files. "State machine guardrails that control which tools your AI agent can use in each phase. Define a workflow once, enforce it across Claude Code, Codex, Cursor, opencode, and Pi." && "Instead of making the model bigger, make the problem smaller."
* Observable!
* Provider-independent
* Local. Independent. Markdown?
* Independent. Dependable. Markdown?