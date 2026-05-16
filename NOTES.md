Alternativen Modellprovider testen: Synthetic.new - wie Featherless, 30€ / Monat, scheinbar zuverlässiger
Wakeups / Alerts per Datenbank bauen
hostname limits in mcp.yml parsen

Reflect and learn from things when memory plugin is ready:
* Mail Digest
* ...

MCP functions: keep or remove the renaming of "-"?

## For later

- MS365: Enable / Disable Out of Office Notes
- Protect the bastion port on the host? Maybe a simple basic auth?
- Spotify MCP based on https://github.com/aome510/spotify-player


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
  - ~/familiar/container/build.sh
  - Use node-linux or node-mac packages to create a native service