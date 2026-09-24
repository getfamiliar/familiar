# Generic node runtime for `source: npm` MCPs. The bastion's
# NpmFactory invokes this image with `<package>[@<version>]` and any
# extra args; the ENTRYPOINT runs `npx -y <package>...` so the
# package's bin executes the moment its install finishes.
#
# HOME=/work + WORKDIR=/work means the `~/.npm/_npx/` cache lands
# inside the bind-mounted `/work` (host: `tmp/mcp-mount-<id>`), so a
# warm restart skips the fetch.
# Base pinned by digest so the build cache key is stable. Bump deliberately via
# `docker buildx imagetools inspect node:22-alpine`.
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f
ENV HOME=/work
WORKDIR /work
ENTRYPOINT ["npx", "-y"]
