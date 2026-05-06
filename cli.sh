#!/bin/bash
# Effective Assistant CLI — single entry point.
# Verifies config/config.yml exists, builds the host package if stale,
# and dispatches to the citty-based subcommand router in
# host/src/index.ts.

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${ROOT}/host"
CONFIG_FILE="${ROOT}/config/config.yml"

if [ ! -f "${CONFIG_FILE}" ]; then
  echo "Error: ${CONFIG_FILE} not found." >&2
  echo "Copy config/config.example.yml to config/config.yml and fill it in." >&2
  exit 1
fi

if [ ! -f "${HOST}/build/index.js" ] \
   || [ "${HOST}/src/index.ts" -nt "${HOST}/build/index.js" ]; then
  echo "Building host..." >&2
  (cd "${HOST}" && npm run build >&2)
fi

exec node "${HOST}/build/index.js" "$@"
