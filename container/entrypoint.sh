#!/bin/bash
set -e

echo "Starting Effective Assistant agent container entrypoint..."

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
