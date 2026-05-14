Alternativen Modellprovider testen: Synthetic.new - wie Featherless, 30€ / Monat, scheinbar zuverlässiger
Wakeups / Alerts per Datenbank bauen
hostname limits in mcp.yml parsen

## For later

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

