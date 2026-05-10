Important: finishReason length + other gescheit behandeln
llm failures / 404 codes etc. fixen

Agentruns: mehr Statistiken sammeln

Zeilenlänge in Markdown

## For later

- Protect the bastion port on the host? Maybe a simple basic auth?

## Workspace Linter

- Check reserved group names in toolgroups/: "all", "none", "system"

## Before release

- The whole schema contains migrations at the moment, pull a blank slate

## Security Holes

- Two step installation of pypis can be circumvented as the installation step happens on every daemon boot. Post-install scripts could exfiltrate env variables that a previous MCP run saved inside the container.
