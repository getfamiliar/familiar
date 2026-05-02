#!/bin/bash
# Effective Assistant CLI — single entry point.
# Loads .env, builds the host package if stale, and dispatches to the
# citty-based subcommand router in host/src/index.ts.

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${ROOT}/host"
ENV_FILE="${ROOT}/.env"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Error: ${ENV_FILE} not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# Load .env into the environment for the Node process.
# (Node 20.6+ has --env-file natively; we shell-source for portability with older nodes.)
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [ ! -f "${HOST}/build/index.js" ] \
   || [ "${HOST}/src/index.ts" -nt "${HOST}/build/index.js" ]; then
  echo "Building host..." >&2
  (cd "${HOST}" && npm run build >&2)
fi

exec node "${HOST}/build/index.js" "$@"
