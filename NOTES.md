Agentruns: mehr Statistiken sammeln
Chat History für Non-Chat Events
llm failures / 404 codes etc. fixen

## For later

- Protect the bastion port on the host? Maybe a simple basic auth?

## Workspace Linter

- Check reserved group names in toolgroups/: "all", "none", "system", mcp group ids
- Check the tools in the tool groups for existence
- Parse the tools frontmatter statements and check if they are valid (existing tools and groups and parseable)

## Before release

- The whole schema contains migrations at the moment, pull a blank slate

## Security Holes

- Two step installation of pypis can be circumvented as the installation step happens on every daemon boot. Post-install scripts could exfiltrate env variables that a previous MCP run saved inside the container.
