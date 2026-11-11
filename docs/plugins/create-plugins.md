# Creating Plugins

This guide covers how to write a first-party Familiar plugin in this monorepo and how to get it onto npm the first time. How plugins are loaded and enabled on an instance is in [ci-cd.md](../ci-cd.md#plugins); the config file conventions are in [config.md](../config.md).

## What a plugin is

A plugin is an npm package whose default export is a `definePlugin({...})` manifest (`shared/src/Plugin.ts`). It runs **host-side only**, inside the daemon's Node process. Plugin code never runs in the agent container: tools the agent can call are declared by the plugin and run host-side behind the bastion's `/plugin-tools/` gateway.

A plugin can contribute any combination of:

- **Event sources.** A daemon (`start` / `stop`) that watches something in the world and calls `ctx.events.emit(...)`.
- **Agent tools.** Declared in `tools()` and namespaced as `<plugin-id>_<name>`.
- **Default handlers and skills.** Shipped in a `workspace-template/` folder, seeded into the user's `workspace/` and kept up to date by the workspace updater; one-off migrations go into `workspace-updates/` notes ([workspace-updates.md](../workspace-updates.md)).
- **CLI commands.** Mounted as `familiar <plugin-id> <subcommand>`.
- **Prompt extensions, inference providers, model metadata, and mail / calendar / storage providers.** These go through the `HostContext` APIs and the `getModel*` hooks.

## Package layout

```
plugins/<name>/
  package.json
  tsconfig.json
  README.md                 # optional: user-facing setup notes
  src/
    index.ts                # default export: definePlugin({...})
    <Name>Daemon.ts         # start/stop logic, if any
    Commands.ts             # citty commands, if any
    *.test.ts               # node:test via tsx
  workspace-template/       # optional: default handlers / skills
  workspace-updates/        # optional: update notes (YYYY-MM-DD-<slug>.md)
    <topic>/
      index.md
```

Every directory under `plugins/` is a workspace of the root `package.json` (`plugins/*`). The root `npm run build` builds it, and the release pipeline publishes it, without any edit to the root `package.json` or the workflow.

### `package.json`

Copy an existing plugin and adapt it. `plugins/tailscale/package.json` is a small, current example.

```json
{
    "name": "@getfamiliar/plugin-<name>",
    "type": "module",
    "version": "0.0.1",
    "description": "Familiar plugin: <one sentence>.",
    "publishConfig": { "access": "public" },
    "main": "build/index.js",
    "types": "build/index.d.ts",
    "familiar": { "plugin": true },
    "files": ["build", "workspace-template", "workspace-updates"],
    "engines": { "node": ">=22" },
    "scripts": {
        "build": "tsc",
        "format": "biome format --write --config-path ../.. src/",
        "format:check": "biome format --config-path ../.. src/",
        "lint": "biome lint --config-path ../.. src/",
        "check": "biome check --config-path ../.. src/",
        "test": "tsx --test 'src/**/*.test.ts'"
    },
    "license": "MIT",
    "dependencies": {
        "@getfamiliar/shared": "*",
        "citty": "^0.1.6"
    },
    "devDependencies": {
        "@biomejs/biome": "^2.4.12",
        "@types/node": "^22",
        "typescript": "^6.0.3"
    }
}
```

The fields that matter:

- **`familiar.plugin: true`** is required. The loader refuses any package without it and never imports its module (`host/src/plugins/PluginLoader.ts`).
- **`familiar.bundled: true`** makes the plugin core: always on, and shipped as a dependency of `@getfamiliar/cli`. Leave it out for optional plugins, which users enable through `config/plugins`. Don't set it before the first npm publish; see [First release](#first-release-to-npm).
- **Internal dependencies are pinned as `"*"`.** `scripts/ci-stamp.mjs` rewrites them to the exact release version at publish time. Never write a concrete version for `@getfamiliar/*` dependencies.
- **`version` stays at `0.0.1`.** CI stamps the real lockstep version (`0.1.<run>`). It's never committed back.
- **`files`** must list everything the package needs at runtime. Leave out `workspace-template` / `workspace-updates` if the plugin doesn't ship them.
- **`"private": true`** keeps the plugin off npm; the publish loop skips it.

### `tsconfig.json`

Copy it from any plugin unchanged: `NodeNext` modules, `src/` → `build/`, `declaration: true`, `strict: true`.

## The manifest

```ts
import path from "node:path";
import { definePlugin } from "@getfamiliar/shared";
import { buildCommands } from "./Commands.js";
import { startExampleDaemon, stopExampleDaemon, EXAMPLE_TOPIC } from "./ExampleDaemon.js";

/**
 * Example host-side plugin. Self-disables when `example.apiKey` is unset.
 */
export default definePlugin({
    id: "example",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    // Optional: one-off update notes, see docs/workspace-updates.md.
    workspaceUpdates: path.join(import.meta.dirname, "..", "workspace-updates"),
    host: {
        start: (ctx) => startExampleDaemon(ctx),
        stop: () => stopExampleDaemon(),
        getEmittedEvents: (ctx) =>
            ctx.config.getString("example.apiKey", null) === null
                ? []
                : [{ topic: EXAMPLE_TOPIC, description: "Something happened in Example." }],
        tools: (ctx) => [/* PluginTool objects */],
        commands: (ctx) => buildCommands(ctx),
    },
});
```

**`id`** must match `[a-z0-9-]+`. It is the CLI namespace (`familiar example …`), the config group (`example.*`), the tool prefix (`example_<tool>`) and the auto tool group. A plugin that has tools must also satisfy `IDENT_PATTERN`, and its id must not collide with an MCP id.

### Host hooks

All hooks are optional and receive the plugin-scoped `HostContext`.

| Hook | When | Rules |
| --- | --- | --- |
| `prepare(ctx)` | Once per process start and on every plugin restart, before any `start` and before plugin CLI commands | Synchronous. No network, no DB, no daemons. Register storage providers, prompt placeholders and trusted proxies here so the CLI sees them without the daemon. |
| `start(ctx)` | Daemon boot, after every plugin's `prepare` | Resolve once setup is done. Long-lived work runs on background promises the plugin owns. |
| `stop(ctx)` | Daemon shutdown (LIFO) and before a restart | Release **everything** `start` set up (timers, poll loops, sockets, chat / workspace subscriptions) and reset module state. Must fit the shared drain budget. |
| `tools(ctx)` | After `start`, at boot and after every restart | Synchronous and side-effect-free; just build the list. |
| `webMenu(ctx)` | After `start`, at boot and after every restart | Returns menu items for the web UI's sidebar (see [Web UI menu items](#web-ui-menu-items)). Synchronous and side-effect-free. |
| `webPlugin(ctx)` | After `start`, at boot and after every restart | Returns an HTTP controller (mounted at `/plugins/<id>/`), an optional page for the web UI and optional WebSocket endpoints (see [Plugin pages and controllers](#plugin-pages-and-controllers)). Synchronous; just build and return. |
| `webUi(ctx)` | After `start`, at boot and after every restart | Returns the web UI's root controller (see [Providing the web UI](#providing-the-web-ui)). Synchronous; just build the Hono app. |
| `getEmittedEvents(ctx)` | `familiar events list-topics`, also without the daemon | Synchronous. Derive the list from constants and `ctx.config`. |
| `commands(ctx)` / `main(ctx)` | CLI dispatch | citty commands under `familiar <id>`. `main` runs when no subcommand is given. |
| `getModelProviders` / `getModelMetaData` | Inference provider resolution | Only for plugins that own an inference provider (see `plugins/featherless`). |
| `restartOnConfigChange` | Config reload | Foreign config keys (outside `<id>.*`) that the plugin captures in `prepare` / `start`. |

A plugin that has a `start` but no `stop` can't be restarted in-process, so a config reload reports "daemon restart required" for it. Always pair the two.

### `HostContext` at a glance

- **`ctx.config`** reads `config.yml` (`getString` / `getNumber` / `getBool` / `getArray` / `getStringList`, with optional defaults). Read values per use rather than caching them, so a hot reload takes effect.
- **`ctx.events.emit({ topic, prompt, payload, idempotencyKey, … })`** writes an event to the bus. Always pass a stable `idempotencyKey` derived from the source (e.g. `telegram:<update_id>`). If you use the returned `settled` promise, attach a `.catch` to it.
- **`ctx.logger`** is a scoped structured logger. Put every key identifier into the message text itself.
- **`ctx.chat`**, **`ctx.prompt`**, **`ctx.mail`** / **`ctx.calendar`** / **`ctx.storage`**, **`ctx.mcp`**, **`ctx.workspace`** and **`ctx.inference`** are the host services. See the JSDoc in `shared/src/Plugin.ts`.
- **`ctx.web.registerTrustedProxy(...)`** makes the plugin a trusted reverse proxy of the core webserver; see [proxy-plugins.md](proxy-plugins.md).
- **`ctx.familiarVersion`** is the version of the running familiar host.
- **`ctx.scratch`** gives access to an event's scratch folder (`/scratch/<event-id>/` in the containers):
  - `addFiles` stages files.
  - `listFiles` lists the files.
  - `resolveFile` returns a file's host path for reading or streaming.
  - Files whose name starts with `.` are internal (spilled tool results, plugin bookkeeping). Leave them out wherever you show files to the user (`isHiddenScratchFile`).
- **`ctx.workspaceHistory.commitFiles(paths, message)`** commits workspace files to the workspace's git history, for a plugin that rewrites workspace files itself instead of through an agent run, so the user can inspect and revert the change. Commit the same paths once before writing (snapshot) and once after. Returns `null` without a commit when `core.autoUpdate` is `false`. Example: the memory plugin's nightly date rewrite. **`ctx.workspaceHistory.commitDirectory(dir, message)`** does the same for everything below one folder — added, changed and deleted files — for passes whose agent runs create, rename or delete files that aren't known up front (the memory plugin's split, dedup and dream passes commit `wiki` before and after).
- **`ctx.workspaceReads.summarize({ pathPrefix, since, excludeHandlerPrefixes })`** tells how many distinct agent runs read each workspace file below a prefix with `fs_read` (and when last), from the core table `file_reads` (kept `core.fileReadRetentionDays`, default 14). Example: the memory plugin's "hot" files for dreaming.
- **`ctx.database`** runs SQL on the host's postgres (`query(sql, values)`, `transaction(work)`), for plugins that keep their own tables. Create them idempotently in a postgres schema named after the plugin (`CREATE SCHEMA IF NOT EXISTS <id>`), and never touch the bus tables. Works in CLI commands too while `familiar-postgres` runs. Example: the memory plugin's wiki index.
- **`ctx.isDevMode`** is `true` in a monorepo dev run (`npm run dev`, `FAMILIAR_DEV=1`), for developer conveniences such as hot reloading.
- **`ctx.dataDir`** / **`ctx.workspaceDir`** / **`ctx.tmpDir`** hold the instance paths. Persistent plugin state goes under `dataDir`.
- **`ctx.daemonDownSignal`** / **`ctx.isDaemonRunning()`** tell long-running loops whether the daemon is still up.

## Configuration

- **The plugin owns the top-level group `<id>.*`** in `config/config.yml`. The platform doesn't validate it; the plugin parses its own subtree.
- **A plugin without config disables itself.** When its required keys are absent, log a warning and return from `start` without doing anything, and return `[]` from `getEmittedEvents`. Don't throw.
- **Secrets are any key whose path segment contains `key`, `token`, `password` or `secret`** (e.g. `example.apiKey`). Agent config tools mask such keys on read and refuse them on write, and `familiar config set` prompts for them hidden. Name secret keys so they match this rule.
- **Document every key** in `config/config.example.yml` (commented-out sample block) and in `docs/config.md`.
- **Reload.** A change to `<id>.*` restarts the plugin automatically. A foreign key captured at start (e.g. `webserver.port`) belongs in `restartOnConfigChange`.

## Tools

The full guide to designing and implementing agent tools (naming, groups, levels, schema, description, results, errors, tests) is [agent-tools.md](../agent-tools.md). In short: a `PluginTool` has `name` (bare, without prefix), `description` (what the model sees), `inputSchema` (raw JSON Schema), `execute(args, callCtx)`, and optionally `groups` and `level`.

- **`level`** is `default` (anyone), `approval` (external mutations such as sending mail) or `privileged` (trusted-input runs only). It's enforced container-side.
- **`groups`** opts the tool into curated sets. Use `core` only for genuinely ambient capabilities. The plugin id is already an auto-group; don't list it.
- **Results go straight back to the model.** For large or JSON-lines output, use `runJsonTool` & co. from `shared/src/ToolRunner.ts` with `callCtx.toolRunContext`, so oversized results spill to scratch.
- **Register tools unconditionally.** If the feature is off, fail at call time with an error that names the config switch. Don't hide tools behind config flags.

## Workspace template and handlers

Files under `workspace-template/` are seeded into `workspace/` when missing. Later changes to them reach existing workspaces through the workspace updater: files the user never edited are updated automatically, customized ones are merged by an `update:merge-file` agent run per file, and nothing is overwritten without a commit in the workspace git history. Changes a file diff can't express (a renamed placeholder or tool, a moved file, a convention that affects files the user created) need an **update note** in `workspace-updates/` — see [workspace-updates.md](../workspace-updates.md) for how to write one. Ship a default handler for each topic the plugin emits. Handler paths follow the topic: `chat:telegram` → `workspace-template/chat/telegram.md`. Every path segment must be a valid topic word (`[\w-]+`). See CLAUDE.md, sections "Handler resolution" and "Prompt template", plus [prompting.md](../prompting.md), for frontmatter (`model`, `tools`, `skills`, `cron`, …).

Shared how-to knowledge goes into `workspace-template/skills/<name>/SKILL.md` instead of being duplicated across handlers.

## Providing the web UI

The core webserver only authenticates; the pages come from a plugin whose `webUi(ctx)` hook returns a `WebUi` (types from `@getfamiliar/shared`): a root `controller`, a `Hono<WebUiEnv>` app mounted at `/`, and optionally `renderAuthPage`. `plugins/web-ui` is the reference implementation.

- **Auth is done before your routes run.** Every request reaching the controller passed the core auth middleware; `c.get("principal")` is the signed-in, allowlisted user (`login`, `displayName`, `via`). Don't add your own login.
- **Core routes win.** `/login`, `/login/:token` and `/logout` are registered before the controller; a catch-all in the controller cannot shadow them. Sign out with a `POST /logout`.
- **Login pages: markup only.** `renderAuthPage(view)` turns a `WebAuthPageView` (`signedIn`, `signedOut`, `confirmLoginLink`, `invalidLoginLink`) into a complete HTML document. The core decides which page, the status code, the form actions and everything a form submission does. The page is served under a strict CSP (no scripts, no external resources, inline styles and `data:` fonts / images only, forms to the same origin), so it must be self-contained: these pages are reachable without a session, so the UI's (authenticated) assets aren't available to them. Escape all text. If the renderer is missing or throws, the core serves its plain page and logs the error.
- **Node bindings.** `c.env.incoming` / `c.env.outgoing` are the raw node request and response, e.g. to hand a request to connect-style middleware and answer with `RESPONSE_ALREADY_SENT` (`@hono/node-server/utils/response`).
- **Swapped on restart.** The hook runs after `start`; on a plugin restart the old controller is dropped and the new one is mounted without rebinding the socket. A disabled plugin provides no UI.
- **One UI at a time.** With several providers, `webserver.uiPlugin` picks one; with none (or an ambiguous choice) the webserver serves a plain page saying what to install or configure.

## Web UI menu items

Any plugin can put entries into the web UI's sidebar by returning a `WebMenuContribution` from `webMenu(ctx)`:

```ts
webMenu: () => ({
    weight: 10, // position among the plugins: lower comes first (default 0, ties by plugin id)
    items: [
        { icon: "calendar-days", label: "Calendar", route: "/plugins/my-plugin/calendar" },
        {
            icon: "mail",
            label: "Mail",
            route: "/plugins/my-plugin", // optional for a group: the label then links here
            children: [
                { label: "Inbox", route: "/plugins/my-plugin/inbox" },
                { label: "Drafts", route: "/plugins/my-plugin/drafts" },
            ],
        },
    ],
}),
```

- An item is a direct link (`route`, no `children`) or a collapsible group (`children`, optionally with its own `route`). A plugin may return as many items as it wants; they keep their order.
- `icon` is a [lucide](https://lucide.dev/icons) icon id in kebab-case. Routes are paths inside the web UI, starting with `/`.
- The core validates the items. A malformed item disables the plugin in phase `webMenu`, with a message naming the item.
- The web UI opens the first route of the sorted menu instead of its start page. With no items it stays on the start page.
- The web UI reads the sorted list with `ctx.web.listMenuItems()`.

## Plugin pages and controllers

A plugin that needs HTTP routes or a page in the web UI returns a `WebPluginUi` from `webPlugin(ctx)` (types from `@getfamiliar/shared`). `plugins/web-chat` is the reference implementation.

```ts
webPlugin: (ctx) => ({
    controller, // Hono<WebUiEnv>, mounted at /plugins/<id>/ behind the core auth
    page: {
        module: "page/page.js", // built ES module, served by your own controller
        sourceFile: ctx.isDevMode ? path.join(root, "src", "page.tsx") : undefined,
    },
    sockets: [{ path: "/socket", onConnection: (peer, info) => … }], // optional
}),
```

- **Controller.**
  - Mounted at `/plugins/<plugin-id>/`, behind the core authentication (`c.get("principal")` is set), after the login routes and before the web UI.
  - Register concrete routes only (`/api/*`, `/page/*`, …), **no catch-all**: every path the controller doesn't match falls through to the web UI. That is how the browser routes of your page (`/plugins/<id>`, `/plugins/<id>/…`) reach it.
  - It is swapped without a restart of the webserver when the plugin restarts.
- **Page.**
  - The web UI loads the page for every route under `/plugins/<plugin-id>`.
  - It imports the module and calls its default export, `MountWebPage`: `mount(container, { basePath, pathname, user, assistant, navigate })` renders into the content area next to the sidebar and returns an unmount function.
  - The contract is framework-agnostic. A React page creates its own root and brings its own React in production.
  - Add a menu entry that links to the page via `webMenu`.
- **Styles.**
  - Import your CSS as `?inline` and inject it as a `<style>` while mounted. The web UI already loads the Geist font and the shadcn theme tokens, so a shadcn page looks native.
  - **Scope it to your container.** Two Tailwind builds on one page override each other's utilities and variants, for example your `.hidden` beating the sidebar's `md:block`. web-chat's `scopeStylesheet` (`plugins/web-chat/src/lib/scoped-style.ts`) wraps the sheet in `@scope ([data-familiar-page="<id>"])`, keeps `@property` / `@keyframes` / `@font-face` top-level and moves Tailwind's theme variables from `:root` to `:scope`. Copy it.
  - Don't render portals (Radix tooltips, popovers, dialogs into `document.body`). They end up outside the scope, so use `title` or inline elements.
- **Dev mode.**
  - With `sourceFile` set, the web UI's Vite server loads the page from source (`/@fs/…`): one React, and Fast Refresh across all plugins.
  - `@/` resolves to the `src/` of the package the importing file belongs to.
  - Keep component files free of non-component exports, and accept your own `?inline` CSS in the entry (`import.meta.hot.accept("./index.css?inline", …)`). Otherwise an edit falls back to a full reload.
- **Build.** A Vite library build (`build.lib`, format `es`) into a directory your controller serves with `WebStaticAssets` from shared (`spaFallback: false`, `urlPrefix: "/plugins/<id>/page"`).
- **WebSockets.** `plugins/gpt-voice` is the reference implementation.
  - Each entry of `sockets` is served at `/plugins/<plugin-id><path>` (exact match, query ignored). A WebSocket handshake never reaches the Hono controller; the core handles it.
  - The core authenticates every handshake like an ordinary request (trusted-proxy login or session cookie, allowlist). It also **requires a same-origin `Origin` header**: a handshake is a GET, and without this check any website could open a socket with the user's cookie. Refusals are plain HTTP 401 / 403 / 404.
  - `onConnection(peer, { principal, isHttps })` gets a library-independent `WebSocketPeer` (`send`, `close`, `onMessage`, `onClose`, `bufferedAmount`, `isOpen`); text frames arrive as string, binary frames as bytes, at most 1 MiB per frame.
  - All sockets of a plugin are closed with code 1012 when it restarts, and with the webserver. Build the URL in the page from `location` (`wss:` on HTTPS) and `basePath`.

## CLI commands

Build citty commands in `Commands.ts`. Human-facing output goes through `writeMarkdown` (with a `--raw` flag) and `markdownTable` from `@getfamiliar/shared`. Interactive prompts and machine-readable output are the exceptions.

## Developing locally

1. Create the folder, then run `npm install` at the repo root to link the new workspace.
2. Enable the plugin in the checkout. A bundled plugin loads automatically; an optional one needs a line with its package name in `config/plugins`.
3. Add its config group to `config/config.yml` and run `npm run dev -- start`. The dev launcher rebuilds stale packages before starting.
4. Before pushing, run the same checks CI runs:

   ```bash
   npm run build
   npm run format:check -w plugins/<name>
   npm run lint -w plugins/<name>
   npm test -w plugins/<name>
   ```

## First release to npm

The release workflow publishes through **npm Trusted Publishing** (GitHub OIDC); it has no npm token. A trusted publisher can only be configured for a package that **already exists** on npm. So the first version of a new plugin is published once **by hand**, as a placeholder. Every version after that comes from CI.

> **Order matters.** Every push to `main` runs a release. If the plugin reaches `main` before it exists on npm with a trusted publisher, the publish loop fails at that plugin with `E404 Not Found - PUT …`. By then `shared` and the plugins before it are already published, but `host` and `cli` are not, so the release is partial. If the code has to land on `main` earlier, set `"private": true` until the steps below are done.

### Steps

1. **Check the package name.** It must be the final name (`@getfamiliar/plugin-<name>`), because the npm entry is created under exactly this name.

2. **Don't set `familiar.bundled` yet.** `scripts/ci-stamp.mjs` adds every bundled plugin to the dependencies of `@getfamiliar/cli`, and it ignores `private`. A bundled plugin that isn't on npm yet makes the published `cli` uninstallable.

3. **Publish the placeholder locally:**

   ```bash
   npm login                                          # interactive, with 2FA
   npm run build                                      # shared + all plugins
   npm publish -w plugins/<name> --access public      # publishes 0.0.1 with "*" deps
   ```

   The placeholder has unpinned `"*"` internal dependencies and is not meant to be used. The next CI release replaces it as `latest`.

4. **Configure the trusted publisher** on npmjs.com → package → Settings → Trusted Publisher → GitHub Actions:

   | Field | Value |
   | --- | --- |
   | Organization or user | `getfamiliar` |
   | Repository | `familiar` |
   | Workflow filename | `release.yml` |
   | Environment | *(empty)* |

   Optionally, under Settings → Publishing access, enable "Require two-factor authentication and disallow tokens". After that, only the workflow can publish.

5. **Remove `"private": true`** (if you set it), set `familiar.bundled: true` if the plugin is core, then push to `main`. CI publishes the real `0.1.<run>` version with pinned dependencies and provenance.

6. **Optional: deprecate the placeholder**, so nobody installs it by accident:

   ```bash
   npm deprecate @getfamiliar/plugin-<name>@0.0.1 "placeholder, use a 0.1.x release"
   ```

### If the publish fails with E404

For scoped packages npm reports missing authorization as `404 Not Found` on the `PUT`, not as 401/403. In practice the cause is one of these:

- The package isn't on npm yet (step 3 was skipped).
- The package has no trusted publisher, or the publisher's repository or workflow file name doesn't match exactly (step 4).
- The workflow's npm is older than 11.5.1. The `publish-npm` job installs `npm@^11.5.1` for this reason; don't remove that step, and don't bump it to `latest`: npm 12 refuses git dependencies by default (`EALLOWGIT`), which breaks `npm ci` on the whatsapp plugin's `libsignal`.

A successful "Signed provenance statement" line before the error proves nothing: provenance signing uses OIDC against Sigstore and is independent of the publish authorization.

## Checklist

- [ ] `plugins/<name>/` with `package.json` (`familiar.plugin: true`, `"*"` internal deps, `files`), `tsconfig.json`, `src/index.ts`
- [ ] `stop` releases everything `start` set up; `prepare` / `tools` / `getEmittedEvents` are synchronous and side-effect-free
- [ ] The plugin disables itself when its config group is missing; secret keys are named per the secret rule
- [ ] Config keys documented in `config/config.example.yml` and `docs/config.md`
- [ ] Default handlers for every emitted topic in `workspace-template/`
- [ ] An update note in `workspace-updates/` for every change existing workspaces can't pick up from the template diff alone
- [ ] Tests, `format:check` and `lint` pass
- [ ] Core vs. optional split updated in [ci-cd.md](../ci-cd.md#core-vs-optional)
- [ ] First release: placeholder published by hand, trusted publisher configured, *then* pushed to `main` (and only then `familiar.bundled`)
