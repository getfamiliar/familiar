# Familiar Agent Container

FROM node:24-slim

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

# Copy shared types package and build it
COPY shared/ /shared
RUN cd /shared && npm install && npm run build

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY container/package*.json ./
COPY container/tsconfig.json ./

# Rewrite the workspace-resolved `*` version of @getfamiliar/shared to
# the in-image path so npm doesn't try to hit the registry (the scope
# is unpublished — every workspace package resolves locally on the host
# via npm workspaces, but the container build has no workspace context).
RUN sed -i 's|"@getfamiliar/shared": "\*"|"@getfamiliar/shared": "file:/shared"|' package.json && npm install

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

# Python packages for the bash tool. The list comes from config.python.packages,
# forwarded as the PYTHON_PACKAGES build-arg by ensureAgentImage. Installed into
# the system interpreter with --break-system-packages (this is a single-purpose
# container, so there's no system Python to protect, and it avoids venv symlink /
# PATH / sudo-secure_path pitfalls — `python3` resolves the packages no matter how
# it's invoked, including via `sudo -u unpriv`). `python` is aliased to `python3`.
# Declared and run last so changing the list only rebuilds this layer.
# `--timeout 120 --retries 10` keep this layer resilient on slow / flaky links
# (e.g. WSL2): the default 15s per-read timeout and 5 retries otherwise abort the
# build with a ReadTimeoutError mid-download.
ARG PYTHON_PACKAGES=""
RUN if [ -n "${PYTHON_PACKAGES}" ]; then \
        pip3 install --no-cache-dir --break-system-packages \
            --timeout 120 --retries 10 ${PYTHON_PACKAGES}; \
    fi \
    && ln -sf /usr/bin/python3 /usr/local/bin/python

# Set working directory to workspace
WORKDIR /workspace/

# Long-running entry: provisions users, then drains the events table via worker loops.
ENTRYPOINT ["/app/entrypoint.sh"]
