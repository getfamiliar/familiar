#!/bin/bash
# Starts the effective-assistant host daemon in the foreground.
# The daemon owns the singleton anthropic-proxy and the long-running
# `ea-agent` container. Run in its own shell; press Ctrl+C (or send
# SIGTERM via cli/stop.sh) to drain and shut down cleanly.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOST_DIR="${PROJECT_ROOT}/host"
ENV_FILE="${PROJECT_ROOT}/.env"
PID_FILE="${PROJECT_ROOT}/data/.daemon.pid"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Error: ${ENV_FILE} not found. Copy .env.example to .env and set ANTHROPIC_API_KEY." >&2
  exit 1
fi

# Refuse to start if a previous daemon still owns the pidfile.
if [ -f "${PID_FILE}" ]; then
  existing_pid="$(cat "${PID_FILE}")"
  if [ -n "${existing_pid}" ] && kill -0 "${existing_pid}" 2>/dev/null; then
    echo "Daemon already running (pid ${existing_pid}). Run cli/stop.sh first." >&2
    exit 1
  fi
  rm -f "${PID_FILE}"
fi

# Load .env into the environment.
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

# Build the host package if the compiled entry is missing or out of date.
if [ ! -f "${HOST_DIR}/build/daemon.js" ] \
   || [ "${HOST_DIR}/src/daemon.ts" -nt "${HOST_DIR}/build/daemon.js" ]; then
  echo "Building host package..." >&2
  (cd "${HOST_DIR}" && npm run build >&2)
fi

exec node "${HOST_DIR}/build/daemon.js"
