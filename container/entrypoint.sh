#!/bin/bash
set -e

echo "Starting Familiar agent container entrypoint (two-user setup + nodemon/tsx)..."

# Host operator's uid/gid, injected by the host (AgentContainer). The agent's
# main process runs as a user with this uid so files it writes are host-owned,
# closing the gap where the container otherwise ran as the image's node uid.
: "${HOST_UID:?HOST_UID must be set}"
: "${HOST_GID:?HOST_GID must be set}"

# Fixed uid for the least-privilege bash user; bumped if it would collide with
# the operator's uid.
UNPRIV_UID="${UNPRIV_UID:-1001}"
if [ "${UNPRIV_UID}" = "${HOST_UID}" ]; then
    UNPRIV_UID=1002
fi

# node:slim ships a uid/gid-1000 `node` user. Remove it and anything else
# occupying our target ids/gid so getpwuid(HOST_UID)/getgrgid(HOST_GID) resolve
# unambiguously to priv/familiar. This matters for sudo: it identifies the
# invoking user by uid → name, so a stale uid-1000 `node` entry would shadow
# `priv` (the common case where the operator is uid 1000) and silently break
# the NOPASSWD rule, forcing a password the agent can't supply.
userdel -f node 2>/dev/null || true
for uid in "${HOST_UID}" "${UNPRIV_UID}"; do
    name="$(getent passwd "${uid}" | cut -d: -f1 || true)"
    if [ -n "${name}" ]; then
        userdel -f "${name}" 2>/dev/null || true
    fi
done
gname="$(getent group "${HOST_GID}" | cut -d: -f1 || true)"
if [ -n "${gname}" ] && [ "${gname}" != "familiar" ]; then
    groupdel "${gname}" 2>/dev/null || true
fi

# Shared group both users belong to. Group membership + the group-write bit is
# what lets `unpriv` write group-writable (writablePaths/scratch) paths while
# being denied protected ones.
groupadd -g "${HOST_GID}" familiar
# Privileged user: uid = host operator, primary group familiar. Main process
# runs as this; everything it writes is host-owned.
useradd -u "${HOST_UID}" -g familiar -m -d /home/priv -s /bin/bash priv
# Least-privilege user the bash tool drops to; same group, different uid.
useradd -u "${UNPRIV_UID}" -g familiar -m -d /home/unpriv -s /bin/bash unpriv

# Two narrow rules: priv may drop to unpriv (run bash unprivileged), and priv
# may run the fixed normalizer as root (post-bash ownership/mode reconcile).
cat > /etc/sudoers.d/familiar <<'EOF'
priv ALL=(unpriv) NOPASSWD: ALL
priv ALL=(root) NOPASSWD: /usr/local/bin/familiar-normalize
EOF
chmod 0440 /etc/sudoers.d/familiar

# Runtime params for the normalizer. sudo resets the environment, so the
# normalizer can't read HOST_UID/CORE_WRITABLE_PATHS from env when invoked
# post-bash — persist them to a fixed file instead. CORE_WRITABLE_PATHS is
# already a JSON array, so it drops straight into the JSON object.
mkdir -p /etc/familiar
cat > /etc/familiar/normalize.json <<EOF
{"hostUid": ${HOST_UID}, "hostGid": ${HOST_GID}, "writablePaths": ${CORE_WRITABLE_PATHS:-[]}}
EOF

# Boot pass: pin ownership + canonical modes + default ACLs across /workspace
# and /scratch before any agent code runs.
/usr/local/bin/familiar-normalize

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
#
# gosu drops from root to the priv user (= host operator uid) and execs,
# leaving no privileged process behind.
export HOME=/home/priv
umask 0027
cd /app
exec gosu priv:familiar npx nodemon \
    --quiet \
    --legacy-watch \
    --watch src \
    --ext ts \
    --exec "tsx src/index.ts"
