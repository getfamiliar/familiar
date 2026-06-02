# Familiar Agent Container

FROM node:24-slim

# Install system dependencies. gosu drops root → priv at boot; sudo lets the
# non-root agent re-enter root for the fixed normalizer and drop to unpriv for
# the bash tool; acl provides setfacl for default ACLs on writable dirs.
RUN apt-get update && apt-get install -y \
    curl \
    git \
    gosu \
    sudo \
    acl \
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

# Pre-create the least-privilege bash user. The privileged user `priv` and
# the `familiar` group are (re)created at runtime by the entrypoint, since
# their uid/gid track the host operator and are only known then.
RUN useradd -m -d /home/unpriv -s /bin/bash unpriv

# The container starts as root: the entrypoint provisions the two users from
# HOST_UID/HOST_GID, pins workspace permissions, then drops to `priv` via gosu.
# (No `USER` directive and no static chown — both are runtime concerns now.)

# Set working directory to workspace
WORKDIR /workspace/

# Long-running entry: provisions users, then drains the events table via worker loops.
ENTRYPOINT ["/app/entrypoint.sh"]
