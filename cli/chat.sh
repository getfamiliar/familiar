#!/bin/bash
# Sends a single chat message to the agent in a given context.
# Usage: ./cli.sh chat [--context-id <id>] "<prompt>"
#        echo "<prompt>" | ./cli.sh chat [--context-id <id>]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOST_DIR="${PROJECT_ROOT}/host"
ENV_FILE="${PROJECT_ROOT}/.env"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Error: ${ENV_FILE} not found. Copy .env.example to .env and set ANTHROPIC_API_KEY." >&2
  exit 1
fi

# Load .env into the environment. `set -a` exports every variable assigned
# until `set +a`. Values with special characters should be quoted in .env.
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

# Build the host package if the compiled entry is missing or out of date.
if [ ! -f "${HOST_DIR}/build/chat.js" ] \
   || [ "${HOST_DIR}/src/chat.ts" -nt "${HOST_DIR}/build/chat.js" ]; then
  echo "Building host package..." >&2
  (cd "${HOST_DIR}" && npm run build >&2)
fi

exec node "${HOST_DIR}/build/chat.js" "$@"
