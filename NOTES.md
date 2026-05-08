Important: finishReason length gescheit behandeln

## For later

- Protect the bastion port on the host? Maybe a simple basic auth?
- **Resource locks for compound actions.** When the supervisor proposes a compound action affecting multiple resources (calendar slot + mail thread), locks are taken on those resources in the bus state. Other concurrent flows see the locks and avoid conflict. Locks have timeouts to prevent stuck-approval starvation.

## Workspace Linter

- Check reserved group names in toolgroups/: "all", "none", "system"

## Before release

- The whole schema contains migrations at the moment, pull a blank slate

## Security Holes

- Two step installation of pypis can be circumvented as the installation step happens on every daemon boot. Post-install scripts could exfiltrate env variables that a previous MCP run saved inside the container.
