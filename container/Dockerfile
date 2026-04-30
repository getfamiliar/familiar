# Effective Assistant Agent Container

FROM node:24-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install claude-code globally — the agent SDK still expects the binary to be
# available in this image.
RUN npm install -g @anthropic-ai/claude-code

# Copy shared types package and build it
COPY shared/ /shared
RUN cd /shared && npm install && npm run build

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY container/package*.json ./
COPY container/tsconfig.json ./

# Fix shared package path for Docker context and install dependencies
RUN sed -i 's|file:../shared|file:/shared|' package.json && npm install

# Copy entrypoint script and make it executable
COPY container/entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Copy source code. This is only used if the sourcecode is not mounted at runtime
COPY container/src/ ./src

# Create workspace directories
RUN mkdir -p /workspace

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Switch to non-root user (the agent SDK requires running as non-root with bypassPermissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]