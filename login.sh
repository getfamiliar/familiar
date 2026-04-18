#!/bin/bash
# Runs `claude login` inside the agent container.
# Credentials are persisted in data/.claude-auth/ and shared across all containers.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTH_DIR="${SCRIPT_DIR}/data/.claude-auth"

echo ""
echo "=== Effective Assistant: Claude Login ==="
echo ""
echo "This will open the Claude login flow inside the agent container."
echo "Follow the instructions to authenticate via your browser."
echo "Once login completes, Claude Code will start — just type /exit to close it."
echo ""

mkdir -p "${AUTH_DIR}"
[ -f "${AUTH_DIR}/.claude.json" ] || echo '{}' > "${AUTH_DIR}/.claude.json"

docker run -it --rm \
  --add-host=host.docker.internal:host-gateway \
  -v "${AUTH_DIR}:/home/node/.claude" \
  -v "${AUTH_DIR}/.claude.json:/home/node/.claude.json" \
  --entrypoint claude \
  effective-agent \
  login

# Clean up everything the login process created except the two files we need
find "${AUTH_DIR}" -mindepth 1 \
  ! -name '.credentials.json' \
  ! -name '.claude.json' \
  -exec rm -rf {} + 2>/dev/null || true

# Verify the login produced the expected credential files
echo ""
MISSING=0
if [ ! -f "${AUTH_DIR}/.credentials.json" ]; then
  echo "ERROR: .credentials.json was not created. Login may have failed."
  MISSING=1
fi
if [ ! -s "${AUTH_DIR}/.claude.json" ] || [ "$(cat "${AUTH_DIR}/.claude.json")" = "{}" ]; then
  echo "WARNING: .claude.json is empty. Login may not have completed fully."
fi

if [ "${MISSING}" -eq 0 ]; then
  echo "Login successful. Credentials saved to data/.claude-auth/"
else
  echo ""
  echo "Login failed. Please try again."
  exit 1
fi
