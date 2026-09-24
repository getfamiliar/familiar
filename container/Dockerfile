# Familiar Agent Container
#
# Layers are ordered from least to most frequently changing so that source
# edits never invalidate the heavy download layers (apt, pip, npm install):
# base → apt → pip → npm manifests + install → shared/ sources + build →
# container/src. The pip and npm steps additionally use BuildKit cache mounts,
# so even a genuine rebuild of those layers reuses already-downloaded wheels
# and tarballs instead of refetching them.

# Base pinned by digest so the build cache key is stable: a floating tag makes
# BuildKit re-resolve against Docker Hub and rebuild everything whenever
# upstream republishes it. Bump deliberately via
# `docker buildx imagetools inspect node:24-slim`.
FROM node:24-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf

# Install system dependencies. gosu drops root → priv at boot; sudo lets the
# non-root agent re-enter root for the fixed normalizer and drop to unpriv for
# the bash tool; acl provides setfacl for default ACLs on writable dirs;
# python3 + python3-pip back the agent's bash tool (packages added below).
RUN apt-get update && apt-get install -y \
    curl \
    git \
    gosu \
    sudo \
    acl \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Python packages for the bash tool. The list comes from config.python.packages,
# forwarded as the PYTHON_PACKAGES build-arg by ensureAgentImage. Installed into
# the system interpreter with --break-system-packages (this is a single-purpose
# container, so there's no system Python to protect, and it avoids venv symlink /
# PATH / sudo-secure_path pitfalls — `python3` resolves the packages no matter how
# it's invoked, including via `sudo -u unpriv`). `python` is aliased to `python3`.
# Placed right after apt (before any source COPY) so only a base-image or
# package-list change rebuilds it; the pip cache mount keeps downloaded wheels
# across rebuilds.
# `--timeout 120 --retries 10` keep this layer resilient on slow / flaky links
# (e.g. WSL2): the default 15s per-read timeout and 5 retries otherwise abort the
# build with a ReadTimeoutError mid-download.
ARG PYTHON_PACKAGES=""
RUN --mount=type=cache,target=/root/.cache/pip \
    if [ -n "${PYTHON_PACKAGES}" ]; then \
        pip3 install --break-system-packages \
            --timeout 120 --retries 10 ${PYTHON_PACKAGES}; \
    fi \
    && ln -sf /usr/bin/python3 /usr/local/bin/python

# Install shared's dependencies from its manifest alone; its sources are copied
# and built further down, so editing them doesn't re-run this install.
COPY shared/package*.json /shared/
RUN --mount=type=cache,target=/root/.npm cd /shared && npm install

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY container/package*.json ./
COPY container/tsconfig.json ./

# Rewrite the workspace-resolved `*` version of @getfamiliar/shared to
# the in-image path so npm doesn't try to hit the registry (the scope
# is unpublished — every workspace package resolves locally on the host
# via npm workspaces, but the container build has no workspace context).
# The `file:` dependency is a symlink, so only /shared/package.json has to
# exist at this point.
RUN --mount=type=cache,target=/root/.npm \
    sed -i 's|"@getfamiliar/shared": "\*"|"@getfamiliar/shared": "file:/shared"|' package.json && npm install

# Copy shared sources and build them.
COPY shared/ /shared
RUN cd /shared && npm run build

# Copy entrypoint script and the root-only permission-normalizer wrapper.
COPY container/entrypoint.sh ./
COPY container/familiar-normalize /usr/local/bin/familiar-normalize
RUN chmod +x entrypoint.sh /usr/local/bin/familiar-normalize

# Copy source code. This is only used if the sourcecode is not mounted at runtime
COPY container/src/ ./src

# Create workspace directory
RUN mkdir -p /workspace

# The `priv`/`unpriv` users and the `familiar` group are provisioned at runtime
# by the entrypoint, since their uid/gid track the host operator and are only
# known then. The container starts as root and drops to `priv` via gosu (no
# `USER` directive, no static chown — both are runtime concerns now).

# Set working directory to workspace
WORKDIR /workspace/

# Long-running entry: provisions users, then drains the events table via worker loops.
ENTRYPOINT ["/app/entrypoint.sh"]
