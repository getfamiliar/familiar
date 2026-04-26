#!/bin/bash
# Wipes the shared OAuth credentials folder so the next login starts clean.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTH_DIR="${SCRIPT_DIR}/../data/.claude-auth"

if [ ! -d "${AUTH_DIR}" ]; then
  echo "No auth folder at ${AUTH_DIR} — nothing to do."
  exit 0
fi

rm -rf "${AUTH_DIR}"
echo "Removed ${AUTH_DIR}. Run './cli.sh login' to re-authenticate."
