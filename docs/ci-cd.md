# CI/CD and Releases

This document explains how Familiar is packaged, released, and installed — the npm packages, the Docker images, the GitHub Actions pipeline that produces them, and how a running instance consumes them. It is written for two audiences: **users** who want to run an instance out of a folder, and **contributors/maintainers** who work on the release machinery.

## Mental model

Familiar runs in one of two modes, and almost everything below follows from the distinction:

- **Installed mode** — the normal way to run Familiar. You install the `@getfamiliar/cli` npm package (which provides the `familiar` command) into an ordinary project folder (e.g. `~/familiar`) that holds your `config/`, `data/`, and `tmp/`. The CLI runs your instance from that folder and **pulls** prebuilt, version-locked Docker images from a registry. Updating is `npm update` + restart.
- **Development mode** — a checkout of the monorepo, driven by `./cli.sh`. Source is rebuilt on demand, container images are **built locally**, and `container/src` + `shared/build` are bind-mounted into the agent for hot-reload.

The same code powers both; the mode changes only *where paths resolve* and *whether images are built or pulled*.

### Two roots

A running instance separates two concerns that happen to coincide in a checkout:

- **Home directory** (`FAMILIAR_HOME`, defaults to the current working directory) — your data: `config/`, `data/`, `tmp/`. This is what makes an instance yours.
- **Asset root** — the installed `@getfamiliar/host` package: its own version and the `init` templates. Resolved relative to the package, wherever npm put it.

In a monorepo checkout the two coincide at the repo root (`cli.sh` sets `FAMILIAR_HOME` to the checkout). Installed, they diverge — which is exactly what lets you run Familiar from any folder.

## Distribution channels

A release publishes to two places under one shared version:

| Channel | Artifacts |
| --- | --- |
| **npm** (public registry) | `@getfamiliar/shared`, `@getfamiliar/host`, the `@getfamiliar/plugin-*` packages, and the `@getfamiliar/cli` meta-package |
| **GHCR** (`ghcr.io/getfamiliar`) | `familiar-agent`, `familiar-bastion-bridge-img`, `familiar-mcp-runtime-npm`, `familiar-mcp-runtime-pypi` — each `linux/amd64,linux/arm64` |

`@getfamiliar/container` is **not** published to npm: its code is baked into the `familiar-agent` image.

The two channels are bound together at runtime: the host pulls the image tag **equal to its own npm version**. Because a single pipeline run publishes both from the same version, the image a given CLI version needs always exists.

## Running an instance (users)

### Initialize a project

```bash
mkdir ~/familiar && cd ~/familiar
npx @getfamiliar/cli init
```

The installable package is `@getfamiliar/cli`; the command it provides is `familiar`. After a global install (`npm i -g @getfamiliar/cli`) or a project install, you invoke everything as `familiar …`.

`familiar init` scaffolds the folder — it never overwrites existing files, so it is safe to re-run:

```
~/familiar/
  package.json          # depends on @getfamiliar/cli
  config/
    config.yml          # from the template; fill this in
    mcp.yml             # MCP server config
    plugins             # optional-plugin whitelist (see “Plugins”)
  data/
    workspace-template/ # seeds data/workspace on first start
  tmp/
```

Then install and start:

```bash
npm install
# edit config/config.yml (postgres password, inference provider + API key, …)
familiar start
```

On first `start`, the CLI pulls the version-locked images from GHCR (no local Docker build), brings up the postgres and agent containers, and begins processing events.

### Updating

```bash
npm update      # pull a newer @getfamiliar/cli (and plugins)
familiar start  # picks up the matching images automatically
```

Because the CLI derives its image tag from its own version, `npm update` is all that is needed — the next `start` pulls the images for the new version. Images are immutable per version, so a pulled tag is cached and re-pulled only when the version changes.

### CLI commands

| Command | Purpose |
| --- | --- |
| `familiar init` | Scaffold a project in the current folder |
| `familiar start` | Start the daemon (pulls images as needed) |
| `familiar stop` | Stop the daemon |
| `familiar plugin add\|remove\|list` | Manage plugins (see below) |
| `familiar config lint` | Validate `config/config.yml` |
| `familiar events\|agentrun\|cron\|tools\|psql` | Inspect and operate the running system |

Every command except `init` (and `--help`/`--version`) requires an initialized home dir; running one elsewhere prints a clear message pointing you at `familiar init`.

## Plugins

Plugins are npm packages that add capabilities (event sources, tools, model providers). The active set for an instance is the **union** of two sources:

1. **Prebundled core plugins** — always on, shipped as dependencies of the `@getfamiliar/cli` meta-package, no configuration required.
2. **Whitelisted plugins** — everything else, listed one per line in `config/plugins`.

There is no name-pattern magic: a plugin is active because it is bundled or because it is named in the whitelist. Any package — first-party or third-party, under any npm scope — becomes a plugin by adding its name to `config/plugins`.

### Core vs. optional

Whether a first-party plugin is core is declared by a single flag in its own `package.json`:

```json
{
  "name": "@getfamiliar/plugin-cli-chat",
  "familiar": { "bundled": true }
}
```

This flag is the single source of truth. At release time the pipeline reads it to decide which plugins become dependencies of the `@getfamiliar/cli` meta-package (and populates the meta's generated `familiar.bundledPlugins` list). At runtime the host loads the bundled set plus the whitelist.

The current split:

| Core (bundled, always on) | Optional (install + whitelist) |
| --- | --- |
| `cli-chat`, `memory`, `telegram`, `whatsapp`, `transcribe-whisper` | `featherless`, `ms365` |

### `config/plugins`

A plain, line-oriented file. Blank lines and `#` comments are ignored; every other line is a package specifier.

```
# Optional plugins for this instance (core plugins load automatically).
@getfamiliar/plugin-featherless
@getfamiliar/plugin-ms365
```

### Managing plugins

```bash
familiar plugin add @getfamiliar/plugin-featherless   # npm-installs it and adds the line
familiar plugin remove @getfamiliar/plugin-ms365      # drops the line and uninstalls
familiar plugin list                                  # shows core + whitelisted
```

`add` refuses to duplicate a core plugin (they load automatically); `remove` refuses to touch a core plugin (they are managed by the meta-package, not the whitelist).

### Third-party plugins

A third-party plugin is just an npm package whose default export is a `definePlugin(...)` manifest. Publish it under any name, then on any instance:

```bash
familiar plugin add @acme/familiar-jira
```

It is resolved and imported from the project's `node_modules`, exactly like a first-party optional plugin.

## Container images

Four images back a running instance:

| Image | Role |
| --- | --- |
| `familiar-agent` | The long-running agent runtime (reasoning + tool use) |
| `familiar-bastion-bridge-img` | socat sidecar bridging the agent's isolated network to the host bastion |
| `familiar-mcp-runtime-npm` | Generic Node runtime for `source: npm` MCP servers |
| `familiar-mcp-runtime-pypi` | Generic Python runtime for `source: pypi` MCP servers |

### Build vs. pull

The host acquires each image according to `imageMode`:

- **`pull`** (default for installed instances) — pull `ghcr.io/getfamiliar/<image>:<version>` and tag it locally under its plain name, so the rest of the system references a stable local tag. A version is pulled once and reused until the version changes.
- **`build`** (default in a monorepo checkout; `cli.sh` sets it) — build the image locally from the checkout's Dockerfiles.

The `familiar-agent` image is self-contained: it bakes both `shared` and the container source, so it runs the same whether or not the source directories are mounted. In development the host overlays `container/src` and `shared/build` for hot-reload; in an installed instance those mounts are omitted and the baked code runs.

### Overrides

| Variable | Effect | Default |
| --- | --- | --- |
| `FAMILIAR_IMAGE_MODE` | `build` or `pull` | `build` in dev (`FAMILIAR_DEV`), else `pull` |
| `FAMILIAR_IMAGE_REGISTRY` | Registry namespace to pull from | `ghcr.io/getfamiliar` |
| `FAMILIAR_IMAGE_TAG` | Tag to pull | the host package's own version |

Use these for mirrors, air-gapped registries, or pinning an instance to a specific image.

## The release pipeline

`.github/workflows/release.yml` runs on every push to `main` (and via manual dispatch). Doc-only changes (`**.md`, `docs/**`, `.claude/**`) are skipped. A `release` concurrency group with `cancel-in-progress: false` ensures a half-finished publish is never aborted mid-flight.

### Jobs

```
test ──▶ version ──┬──▶ publish-npm ────┐
                   └──▶ publish-images ──┴──▶ release
```

1. **test** — `npm ci`, full build, `format:check`, `lint`, and the workspace test suites. Gates everything else.
2. **version** — computes the release version (see below) and exposes it as an output.
3. **publish-npm** — vendors the `init` templates into the host package, stamps the version across all packages, builds, and publishes to npm in dependency order (`shared` → plugins → `host` → `@getfamiliar/cli`) with npm provenance.
4. **publish-images** — a matrix over the four images. Each is **built only when its own inputs change**; otherwise the release tag is re-pointed at the existing image (see below). Multi-arch (`linux/amd64,linux/arm64`), tagged with the version and `latest`, with a per-image GitHub Actions layer cache.
5. **release** — creates the annotated git tag `v<version>` and a GitHub release with generated notes.

`publish-npm` and `publish-images` run in parallel; both consume the same version, which is what keeps npm and GHCR in lockstep.

### Building images only when they change

Container image builds — especially the multi-arch, Python-heavy `familiar-agent` — are expensive, and the images change far less often than the code. Each image is therefore tagged three ways: a **content hash** of its build inputs (`src-<hash>`), the release **`<version>`**, and **`latest`**.

The hash is a deterministic digest of the git tree/blob SHAs of the paths that actually affect the image (for `familiar-agent`: `container/` + `shared/` + the baked Python-packages arg; for the bridge and MCP-runtime images: just their Dockerfile), so identical inputs across releases produce the same tag. On each release, per image:

- if `…:src-<hash>` already exists in the registry, the build is **skipped** and the `<version>` and `latest` tags are pointed at the existing digest with `docker buildx imagetools create` — a metadata-only operation that takes seconds;
- otherwise the image is built and pushed under all three tags.

Every release still produces a `<version>` tag for every image (so the host, which pulls the tag equal to its own npm version, always finds a match), but an actual rebuild happens only when that image's sources change. A host-, plugin-, or docs-only release re-tags all four images without building any of them; the `familiar-agent` image rebuilds only when `container/` or `shared/` changes.

### Version stamping

`scripts/ci-stamp.mjs <version>` runs in the CI working tree only (never committed back). For every publishable package it:

- sets `version` to the release version,
- rewrites internal `"@getfamiliar/*": "*"` (and `"familiar": "*"`) dependencies to that exact version,
- adds a `repository` field (required for npm provenance),
- and, for the `@getfamiliar/cli` meta-package, injects the bundled plugins as pinned dependencies and writes the generated `familiar.bundledPlugins` list — all derived from each plugin's `familiar.bundled` flag.

`scripts/sync-templates.mjs` copies the canonical `config/*.example.yml` and `data/workspace-template/` into `host/template/` so the published `@getfamiliar/host` package carries everything `familiar init` needs. That directory is generated at publish time and is not committed.

### Versioning scheme

Releases are **lockstep**: one version across every package and image. The version is `0.1.<run-number>` — monotonic and computed in CI, not committed back to the repository. The git tag `v<version>` is the durable record of each release. To move to a new minor or major line, bump the base in the `version` job.

## Local development

Contributors work from a checkout via `./cli.sh`, which:

- sets `FAMILIAR_HOME` to the checkout root, so `config/`, `data/`, and `tmp/` are the repo's,
- forces `FAMILIAR_IMAGE_MODE=build` (a checkout has the Dockerfiles and build context),
- rebuilds `shared`, `host`, and the plugins when their sources change, then dispatches to the host CLI.

In this mode the core plugin set is read directly from each `plugins/*/package.json` `familiar.bundled` flag, and optional plugins are enabled via the checkout's `config/plugins`. Everything else — the daemon, watchers, agent runtime — behaves exactly as in an installed instance.

### Repository layout relevant to releases

| Path | Role |
| --- | --- |
| `cli/` | The `@getfamiliar/cli` meta-package (bin shim + CI-injected core-plugin deps) |
| `host/` | `@getfamiliar/host` — the CLI engine; ships `build/` and generated `template/` |
| `shared/` | `@getfamiliar/shared` — types + bus clients used host- and container-side |
| `container/` | Source for the `familiar-agent` image (private; not published to npm) |
| `plugins/*` | The `@getfamiliar/plugin-*` packages |
| `mcp-runtime/{npm,pypi}` | Dockerfiles for the MCP runtime images |
| `scripts/ci-stamp.mjs` | Version stamping + meta wiring |
| `scripts/sync-templates.mjs` | Vendors `init` templates into the host package |
| `.github/workflows/release.yml` | The pipeline |

## One-time operational setup

- **`NPM_TOKEN`** — a repository secret (npm automation token) with publish rights to the `@getfamiliar` scope. GHCR uses the automatic `GITHUB_TOKEN` (the workflow requests `packages: write`).
- **GHCR visibility** — the first publish creates the image packages as private. Make them public so instances can pull anonymously.
- **npm provenance** — requires the workflow's `id-token: write` permission (already set) and the `repository` field that `ci-stamp` injects.

## Known limitations

- **Custom Python packages in pull mode.** The published `familiar-agent` image bakes a fixed default set of Python packages for the agent's tools. An installed instance pulls that image, so customizing `python.packages` beyond the defaults has no effect there. Building a custom image (`FAMILIAR_IMAGE_MODE=build`) requires the container build context, which only a monorepo checkout has. Layering extra packages onto a pulled image is a possible future enhancement.
- **Non-transactional publish.** npm publishing is per-package. If `publish-npm` fails partway, a release can be partial; re-running the pipeline produces a fresh version.
