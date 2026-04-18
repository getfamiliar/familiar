#!/bin/bash
set -e

echo "Starting Effective Assistant agent container entrypoint..."

# Copy shared OAuth credentials into the per-context ~/.claude/
# Credentials are read-only mounted at /auth/, so we copy (not symlink)
# to allow the CLI to update its config during runtime.
# Remove any stale symlinks from previous runs first.
if [ -f /auth/.credentials.json ]; then
  rm -f /home/node/.claude/.credentials.json
  cp /auth/.credentials.json /home/node/.claude/.credentials.json
fi
if [ -f /auth/.claude.json ]; then
  rm -f /home/node/.claude.json
  cp /auth/.claude.json /home/node/.claude.json
fi

# Compile the TypeScript in /app into /tmp/build, linking the node_modules
cd /app && npx tsc --outDir /tmp/build 2>&1 >&2
ln -s /app/node_modules /tmp/build/node_modules
chmod -R a-w /tmp/build

echo "Starting agent with input from stdin..."

# Read the input JSON from stdin (with 1s timeout), defaulting to {} if empty
if read -t 1 -r line; then
  { echo "$line"; cat; } > /tmp/input.json
else
  echo '{}' > /tmp/input.json
fi
node /tmp/build/index.js < /tmp/input.json
