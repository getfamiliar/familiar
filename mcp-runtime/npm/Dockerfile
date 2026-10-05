# Generic node runtime for `source: npm` MCPs. The bastion's
# NpmFactory invokes this image with `<package>[@<version>]` and any
# extra args; the ENTRYPOINT runs `npx -y <package>...` so the
# package's bin executes the moment its install finishes.
#
# HOME=/work + WORKDIR=/work means the `~/.npm/_npx/` cache lands
# inside the bind-mounted `/work` (host: `tmp/mcp-mount-<id>`), so a
# warm restart skips the fetch.
# Base pinned by digest so the build cache key is stable. Bump deliberately via
# `docker buildx imagetools inspect node:24-alpine`.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ENV HOME=/work
WORKDIR /work
ENTRYPOINT ["npx", "-y"]
