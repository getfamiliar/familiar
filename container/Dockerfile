# Familiar Agent Container

FROM node:24-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
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

# Copy entrypoint script and make it executable
COPY container/entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Copy source code. This is only used if the sourcecode is not mounted at runtime
COPY container/src/ ./src

# Create workspace directory
RUN mkdir -p /workspace

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Run as non-root
USER node

# Set working directory to workspace
WORKDIR /workspace/

# Long-running entry: drains the events table via worker loops.
ENTRYPOINT ["/app/entrypoint.sh"]
