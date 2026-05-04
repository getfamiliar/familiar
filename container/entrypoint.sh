#!/bin/bash
set -e

echo "Starting Effective Assistant agent container entrypoint (nodemon + tsx)..."

# nodemon supervises a `tsx` child that runs the TypeScript directly.
# nodemon's `--legacy-watch` polls (every NODEMON_INTERVAL ms) instead
# of using inotify — required because Docker-on-WSL2 bind mounts don't
# propagate inotify events reliably from the host filesystem.
#
# On any change under /app/src, nodemon SIGTERMs the tsx child and
# respawns it. Combined with the host-side bind mount of container/src
# → /app/src, the agent reloads ~1s after an edit on the host with no
# image rebuild and no daemon restart.
#
# The image still has src COPYed in, so running without the mount
# works the same — it just won't pick up live edits.
cd /app
exec npx nodemon \
    --quiet \
    --legacy-watch \
    --watch src \
    --ext ts \
    --exec "tsx src/index.ts"
