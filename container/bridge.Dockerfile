# Minimal socat relay image for the bastion bridge sidecar
# (`familiar-bastion-bridge`). The agent runs on an egress-less
# `--internal` network and cannot reach the host bastion directly; this
# sidecar straddles `familiar-net` (where `host.docker.internal` resolves
# to the host) and `familiar-isolated`, forwarding the agent's bastion
# TCP to the host. socat (not BusyBox `nc`) is required because it can
# `fork` to serve the many concurrent LLM-stream / MCP connections.
#
# The `apk add` needs host internet at build time only; the result is
# layer-cached and the running sidecar never needs the internet beyond
# the single forwarded host endpoint.
FROM alpine:latest
RUN apk add --no-cache socat
