# Generic python runtime for `source: pypi` MCPs. The bastion's
# PypiFactory invokes this image with `<package>[==<version>]` and
# any extra args; the ENTRYPOINT runs `uvx <package>...` so the
# package's CLI executes the moment its install finishes.
#
# HOME=/work + WORKDIR=/work means uv's `~/.local/share/uv/` and
# `~/.cache/uv/` land inside the bind-mounted `/work` (host:
# `tmp/mcp-mount-<id>`), so a warm restart skips the fetch.
FROM python:3.13-slim
RUN pip install --no-cache-dir uv
ENV HOME=/work
WORKDIR /work
ENTRYPOINT ["uvx"]
