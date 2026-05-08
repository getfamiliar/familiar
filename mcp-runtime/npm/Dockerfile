# Generic node runtime for `source: npm` MCPs. The bastion's
# NpmFactory invokes this image with `<package>[@<version>]` and any
# extra args; the ENTRYPOINT runs `npx -y <package>...` so the
# package's bin executes the moment its install finishes.
#
# HOME=/work + WORKDIR=/work means the `~/.npm/_npx/` cache lands
# inside the bind-mounted `/work` (host: `tmp/mcp-mount-<id>`), so a
# warm restart skips the fetch.
FROM node:22-alpine
ENV HOME=/work
WORKDIR /work
ENTRYPOINT ["npx", "-y"]
