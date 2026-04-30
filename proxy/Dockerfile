# Effective Assistant Anthropic Proxy
#
# A tiny Node HTTP reverse proxy that forwards requests to api.anthropic.com
# and injects ANTHROPIC_API_KEY as the x-api-key header. Listens on :8788.

FROM node:24-slim

WORKDIR /app

COPY proxy/package*.json ./
COPY proxy/tsconfig.json ./
RUN npm install

COPY proxy/src/ ./src
RUN npm run build

USER node

ENV PORT=8788
EXPOSE 8788

ENTRYPOINT ["node", "build/index.js"]
