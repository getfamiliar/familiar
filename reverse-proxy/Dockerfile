# Effective Assistant reverse-proxy container
#
# Listens on 8788 inside the ea-net Docker network. Forwards every request
# to the configured UPSTREAM_BASE with an injected Authorization header so
# the agent container never sees the real API key.

FROM node:24-slim

WORKDIR /app

# Copy package files first for better caching
COPY reverse-proxy/package*.json ./
COPY reverse-proxy/tsconfig.json ./

RUN npm install

# Copy source and build
COPY reverse-proxy/src/ ./src
RUN npm run build

# Run as non-root
USER node

EXPOSE 8788

ENTRYPOINT ["node", "build/index.js"]
