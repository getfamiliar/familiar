#!/bin/bash
set -e

echo "Starting Effective Assistant agent container entrypoint..."

# Compile the TypeScript in /app into /tmp/build, linking the node_modules
cd /app && npx tsc --outDir /tmp/build 2>&1 >&2
ln -s /app/node_modules /tmp/build/node_modules
chmod -R a-w /tmp/build

echo "Starting agent..."
exec node /tmp/build/index.js
