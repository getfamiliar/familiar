#!/bin/bash
# Stops the effective-assistant host daemon by reading data/.daemon.pid.
# Sends SIGTERM, waits up to 10 seconds for graceful shutdown, then SIGKILL.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PID_FILE="${PROJECT_ROOT}/data/.daemon.pid"

if [ ! -f "${PID_FILE}" ]; then
  echo "No pidfile at ${PID_FILE}; daemon is not running." >&2
  exit 0
fi

pid="$(cat "${PID_FILE}")"
if [ -z "${pid}" ]; then
  echo "Pidfile is empty; removing." >&2
  rm -f "${PID_FILE}"
  exit 0
fi

if ! kill -0 "${pid}" 2>/dev/null; then
  echo "Pid ${pid} not running; removing stale pidfile." >&2
  rm -f "${PID_FILE}"
  exit 0
fi

echo "Sending SIGTERM to daemon pid ${pid}..." >&2
kill -TERM "${pid}"

for _ in $(seq 1 100); do
  if ! kill -0 "${pid}" 2>/dev/null; then
    echo "Daemon stopped." >&2
    rm -f "${PID_FILE}"
    exit 0
  fi
  sleep 0.1
done

echo "Daemon did not exit within 10s; sending SIGKILL." >&2
kill -KILL "${pid}" 2>/dev/null || true
rm -f "${PID_FILE}"
