#!/bin/bash
# Effective Assistant CLI — dispatches to command scripts in cli/.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="${SCRIPT_DIR}/cli"

usage() {
  cat <<EOF
Usage: ./cli.sh <command> [args]

Commands:
  chat [--context-id <id>] <text>   Send a chat message to the agent.

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
  chat)
    exec "${CLI_DIR}/chat.sh" "$@"
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
