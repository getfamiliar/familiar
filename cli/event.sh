#!/bin/bash
# Inject an event into the bus-state DB. The daemon must be running.
#
# Usage: ./cli.sh event <topic> [payload-json] [--priority N]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOST_DIR="${PROJECT_ROOT}/host"
ENV_FILE="${PROJECT_ROOT}/.env"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Error: ${ENV_FILE} not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# Load .env so POSTGRES_PASSWORD reaches the Node process.
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

# Build the host package if the compiled CLI is missing or out of date.
if [ ! -f "${HOST_DIR}/build/event-cli.js" ] \
   || [ "${HOST_DIR}/src/event-cli.ts" -nt "${HOST_DIR}/build/event-cli.js" ]; then
  echo "Building host package..." >&2
  (cd "${HOST_DIR}" && npm run build >&2)
fi

exec node "${HOST_DIR}/build/event-cli.js" "$@"
