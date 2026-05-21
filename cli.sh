#!/bin/bash
# Familiar CLI — single entry point.
# Verifies config/config.yml exists, rebuilds shared/ and host/ if their
# sources are newer than their compiled output, and dispatches to the
# citty-based subcommand router in host/src/index.ts.
#
# `host` imports `shared` via the `@getfamiliar/shared` workspace
# package, which is a symlink to ../shared at runtime — host reads
# `shared/build/index.js` directly. So both packages need to be in sync
# with their src/ on every invocation.

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="${ROOT}/host"
SHARED="${ROOT}/shared"
PLUGINS_DIR="${ROOT}/plugins"
CONFIG_FILE="${ROOT}/config/config.yml"

if [ ! -f "${CONFIG_FILE}" ]; then
  echo "Error: ${CONFIG_FILE} not found." >&2
  echo "Copy config/config.example.yml to config/config.yml and fill it in." >&2
  exit 1
fi

# Returns 0 (true) when FAMILIAR_DEV is set to 1/true (case-insensitive).
# In dev mode cli.sh rebuilds on any source-newer-than-artifact, runs node
# with --enable-source-maps, and lets deprecation warnings through. In
# production mode (the default) cli.sh builds only when the artifact is
# missing and silences deprecation warnings via --no-deprecation.
is_dev_mode() {
  case "${FAMILIAR_DEV:-}" in
    1|true|TRUE|True) return 0 ;;
    *) return 1 ;;
  esac
}

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

build_pkg() {
  local pkg="$1"
  local label="$2"
  echo "Building ${label}..." >&2
  (cd "${pkg}" && npm run build >&2)
}

if is_dev_mode; then
  if needs_rebuild "${SHARED}"; then build_pkg "${SHARED}" "shared"; fi
  if needs_rebuild "${HOST}";   then build_pkg "${HOST}"   "host";   fi
else
  if [ ! -f "${SHARED}/build/index.js" ]; then build_pkg "${SHARED}" "shared"; fi
  if [ ! -f "${HOST}/build/index.js"   ]; then build_pkg "${HOST}"   "host";   fi
fi

# Plugins are loaded from <plugin>/build/index.js — keep them in sync the same
# way as shared/host so a `git pull` of a plugin actually takes effect on the
# next start (otherwise the daemon happily loads stale compiled code missing
# methods the host now calls on it).
if [ -d "${PLUGINS_DIR}" ]; then
  for plugin in "${PLUGINS_DIR}"/*/; do
    plugin="${plugin%/}"
    [ -f "${plugin}/package.json" ] || continue
    if is_dev_mode; then
      if needs_rebuild "${plugin}"; then build_pkg "${plugin}" "plugin $(basename "${plugin}")"; fi
    else
      if [ ! -f "${plugin}/build/index.js" ]; then
        build_pkg "${plugin}" "plugin $(basename "${plugin}")"
      fi
    fi
  done
fi

if is_dev_mode; then
  exec node --enable-source-maps "${HOST}/build/index.js" "$@"
else
  exec node --no-deprecation "${HOST}/build/index.js" "$@"
fi
