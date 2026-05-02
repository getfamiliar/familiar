#!/bin/bash
# Effective Assistant CLI — dispatches to command scripts in cli/.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="${SCRIPT_DIR}/cli"

usage() {
  cat <<EOF
Usage: ./cli.sh <command> [args]

Commands:
  start              Start the host daemon (foreground; manages proxy + agent container).
  stop               Stop the host daemon and tear down the agent container.
  chat <text>        Send a chat message to the running agent.
  event <topic> ...  Inject an event into the bus-state DB.

Run './cli.sh <command> --help' for command-specific options where available.
EOF
}

if [ $# -eq 0 ]; then
  usage
  exit 1
fi

command="$1"
shift

case "${command}" in
  start)
    exec "${CLI_DIR}/start.sh" "$@"
    ;;
  stop)
    exec "${CLI_DIR}/stop.sh" "$@"
    ;;
  chat)
    exec "${CLI_DIR}/chat.sh" "$@"
    ;;
  event)
    exec "${CLI_DIR}/event.sh" "$@"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: ${command}" >&2
    echo >&2
    usage >&2
    exit 1
    ;;
esac
