# Generic python runtime for `source: pypi` MCPs. The bastion's
# PypiFactory invokes this image with `<package>[==<version>]` and
# any extra args; the ENTRYPOINT runs `uvx <package>...` so the
# package's CLI executes the moment its install finishes.
#
# HOME=/work + WORKDIR=/work means uv's `~/.local/share/uv/` and
# `~/.cache/uv/` land inside the bind-mounted `/work` (host:
# `tmp/mcp-mount-<id>`), so a warm restart skips the fetch.
# Base pinned by digest so the build cache key is stable (a floating tag makes
# BuildKit re-resolve it and rebuild whenever upstream republishes). Bump
# deliberately via `docker buildx imagetools inspect python:3.13-slim`.
FROM python:3.13-slim@sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0
RUN --mount=type=cache,target=/root/.cache/pip pip install uv
ENV HOME=/work
WORKDIR /work
ENTRYPOINT ["uvx"]
