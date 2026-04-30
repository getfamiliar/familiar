# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Effective-assistant is an AI executive assistant built as a containerized agent. It uses Anthropic's `@anthropic-ai/claude-agent-sdk` inside a docker container. A host application (in `host/`) spawns such containers and provides them with an initial JSON task description, MCP tools and a shared workspace.

The system supports multiple **contexts** - a context is a narrowed down task environment. For example, "processing the inbox" is another domain than "summarize community chat groups". Each context comes with its own set of task descriptions and available MCP tools and runs in a separate container instance. All contexts share a common workspace for global statements like the soul, for shared memory and file storage.

## Authentication

Put your Anthropic API key in `.env` at the repo root (see `.env.example`). The host runs a singleton sidecar proxy container (`ea-anthropic-proxy`) that injects the key on every request to `api.anthropic.com`. Agent containers reach the proxy on a private per-context Docker bridge network (`ea-net-{contextId}`); they never see the real key and the proxy is not published to the host.

## Contexts and the `data/` folder

The `data/` folder is the persistent storage for all contexts, memory, sessions etc. The agent get the following folders mounted into its `/workspace/` folder from the projects `data/` folder:

- `global/`: shared across all contexts, for global statements and shared memory
- `context-{id}/` mounted as `context/`: the context-specific statements and memory
- `context-{id}/.claude` mounted as `.claude/`: the context-specific .claude folder for session storage

## Architecture

- **shared/**: TypeScript package (`effective-assistant-shared`) with types used by both host and container. Both sides depend on it via `"file:../shared"` in their package.json. Contains `ContainerParameters` (stdin payload), `ContainerOutput` (result payload), and `TaskDefinition`. Must be built (`npm run build`) before host or container can compile. The Docker build handles this automatically.
- **host/**: Node.js application that spawns and manages agent containers via `ContainerPool`. Owns the `AnthropicProxyManager` lifecycle.
- **container/**: Docker container definition for the agent runtime.
  - Base image: `node:24-slim` with `@anthropic-ai/claude-agent-sdk` as a regular dependency.
  - `src/`: TypeScript application using the SDK's `query()` API.
  - Runs as non-root `node` user.
  - Docker build context is the project root (not `container/`), so `shared/` is available during image build.
- **proxy/**: Tiny Node HTTP reverse proxy. Reads `ANTHROPIC_API_KEY` from its env, forwards every request to `api.anthropic.com`, and overwrites the `x-api-key` header on the way through. Built into the `effective-anthropic-proxy` image.

## Code Style

All TypeScript code is auto-formatted by [Biome](https://biomejs.dev/) on every edit (via a PostToolUse hook in `.claude/settings.json`). Do not manually adjust formatting.

### TypeScript Guidelines

- Document every function with a JSDoc comment: purpose, `@param`, `@returns`, and `@throws` where applicable.
- Use descriptive names — prefer `connectionTimeout` over `connTO`.
- Prefer `const` over `let`. Never use `var`.
- Prefer early returns to reduce nesting depth.
- Keep functions focused and readable; extract helpers when complexity warrants it.
- Use `readonly` on properties and parameters that should not be reassigned.
- Handle errors explicitly — never swallow exceptions with empty catch blocks.
- Folders are named in lower kebab case (eg `mcp-server/`), files are PascalCase (eg `AgentRunner.ts`).

### Shell Scripts

- All shell scripts must pass [shellcheck](https://www.shellcheck.net/).
- Use `set -e` at the top of every script.
- Quote all variable expansions: `"${VAR}"` not `$VAR`.

### Formatting & Linting

```bash
# From container/ or host/
npm run format        # Auto-format all source files
npm run format:check  # Check formatting without modifying (CI)
npm run lint          # Run linter
npm run check         # Format + lint combined
```
