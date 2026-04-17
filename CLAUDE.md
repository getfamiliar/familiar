# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Effective-assistant is an AI executive assistant built as a containerized agent. It uses Anthropic's `@anthropic-ai/claude-code` CLI and communicates via JSON over stdin/stdout.

## Architecture

- **container/**: Docker container definition for the agent runtime
  - Base image: `node:24-slim` with `@anthropic-ai/claude-code` installed globally
  - `src/`: TypeScript application
  - Runs as non-root `node` user

## Build & Run

```bash
# Build the container
docker build -t effective-assistant -f container/Dockerfile container/

# Run (JSON input on stdin, JSON output on stdout)
echo '{}' | docker run -i effective-assistant
```

Inside the container, the TypeScript agent-runner builds with:
```bash
npm install
npm run build          # tsc
```

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
