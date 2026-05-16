# Familiar

**Your personal AI assistant. Loyal. Local. Markdown.**

What's nice about it

Explain whole event-based system: events, handlers, etc.

Tools

Plugins emitting events

Architecture

MCP Integration

call mcp add

* Prefered source: Docker MCP Registry, see
* Secondary: Official MCP Registry, see
* Custom: just go, remember the mcp call command if necessary

## Upgrading from `effective-assistant`

This project was renamed from `effective-assistant` to **Familiar**. If you have an
existing checkout with a running daemon and an on-disk postgres cluster, the cluster
still has the old `ea` role and database baked in. The renamed daemon expects
`familiar` instead, so do this once after pulling:

```bash
./cli.sh stop                       # if it was running
rm -rf data/postgres data/.postgres-port
./cli.sh start                      # recreates the cluster as familiar/familiar
```

You'll lose the in-flight `events` and `agentruns` history. Workspace files, configs,
and the LLM debug logs are untouched.
