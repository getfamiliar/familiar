#!/bin/bash
# Sends a single chat message to the agent in a given context.
# Usage: ./eacli chat [--context-id <id>] "<prompt>"
#        echo "<prompt>" | ./eacli chat [--context-id <id>]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="${SCRIPT_DIR}/../host"

# Build the host package if the compiled entry is missing or out of date.
if [ ! -f "${HOST_DIR}/build/chat.js" ] \
   || [ "${HOST_DIR}/src/chat.ts" -nt "${HOST_DIR}/build/chat.js" ]; then
  echo "Building host package..." >&2
  (cd "${HOST_DIR}" && npm run build >&2)
fi

exec node "${HOST_DIR}/build/chat.js" "$@"
