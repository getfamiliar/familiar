#!/bin/bash
# Effective Assistant CLI — single entry point.
# Verifies config/config.yml exists, rebuilds shared/ and host/ if their
# sources are newer than their compiled output, and dispatches to the
# citty-based subcommand router in host/src/index.ts.
#
# `host` imports `shared` via the `effective-assistant-shared` workspace
# package, which is a symlink to ../shared at runtime — host reads
# `shared/build/index.js` directly. So both packages need to be in sync
# with their src/ on every invocation.

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${ROOT}/host"
SHARED="${ROOT}/shared"
CONFIG_FILE="${ROOT}/config/config.yml"

if [ ! -f "${CONFIG_FILE}" ]; then
  echo "Error: ${CONFIG_FILE} not found." >&2
  echo "Copy config/config.example.yml to config/config.yml and fill it in." >&2
  exit 1
fi

# Returns 0 (true) when any *.ts file under <pkg>/src is newer than
# <pkg>/build/index.js, or when build/index.js doesn't exist yet.
needs_rebuild() {
  local pkg="$1"
  local out="${pkg}/build/index.js"
  if [ ! -f "${out}" ]; then
    return 0
  fi
  if [ -n "$(find "${pkg}/src" -name '*.ts' -newer "${out}" -print -quit 2>/dev/null)" ]; then
    return 0
  fi
  return 1
}

if needs_rebuild "${SHARED}"; then
  echo "Building shared..." >&2
  (cd "${SHARED}" && npm run build >&2)
fi

if needs_rebuild "${HOST}"; then
  echo "Building host..." >&2
  (cd "${HOST}" && npm run build >&2)
fi

exec node "${HOST}/build/index.js" "$@"
