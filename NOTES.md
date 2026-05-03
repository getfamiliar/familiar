- Are subagents really subagents or just workers with own system prompts?

## For later

- **Resource locks for compound actions.** When the supervisor proposes a compound action affecting multiple resources (calendar slot + mail thread), locks are taken on those resources in the bus state. Other concurrent flows see the locks and avoid conflict. Locks have timeouts to prevent stuck-approval starvation.
