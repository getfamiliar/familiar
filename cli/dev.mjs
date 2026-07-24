#!/usr/bin/env node
// Dev launcher for the monorepo checkout — the development counterpart of
// the published `familiar` bin, wired to the root `dev` npm script
// (`npm run dev -- <args>`). It supplies only the conveniences a checkout
// needs and then delegates to the very same `bin/familiar.mjs` production
// entry point, so dev and prod exercise one launch path.
//
// What it adds on top of the bin:
//   1. Staleness rebuild of `shared/`, `host/`, and each `plugins/*` whose
//      compiled `build/index.js` is missing or older than its `src/`. The
//      bin imports `host/build/index.js`, so the build must happen out here,
//      before that import — the host can't compile itself.
//   2. `FAMILIAR_DEV=1` (which makes the host pick image build mode and raise
//      log verbosity) and `FAMILIAR_HOME` pinned to the repo root, so the CLI
//      runs against this checkout regardless of the caller's cwd.
//   3. `--enable-source-maps` for readable stack traces.
//
// This file deliberately lives outside `bin/` so it stays out of the cli
// package's published `files: ["bin"]` set — it is monorepo-only tooling
// that references `shared/`/`host/`/`plugins/` paths absent from an install.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Repo root — this file sits at `<root>/cli/dev.mjs`. */
const ROOT = resolve(import.meta.dirname, "..");

/**
 * Newest modification time (ms) among all `*.ts` files under `dir`,
 * recursing into subdirectories. Returns 0 when the tree has no such files.
 *
 * @param {string} dir Directory to walk.
 * @returns {number} Highest mtimeMs of any `.ts` file found, or 0.
 */
function newestTsMtime(dir) {
    let newest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            newest = Math.max(newest, newestTsMtime(full));
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
            newest = Math.max(newest, statSync(full).mtimeMs);
        }
    }
    return newest;
}

/**
 * Whether a package needs a rebuild: true when its `build/index.js` is
 * missing, or when any `.ts` file under `src/` is newer than that artifact.
 * Faithful port of the old shell launcher's `find -newer` staleness check.
 *
 * @param {string} pkgDir Absolute path to the package directory.
 * @returns {boolean} True if the package should be rebuilt.
 */
function needsRebuild(pkgDir) {
    const out = join(pkgDir, "build", "index.js");
    if (!existsSync(out)) {
        return true;
    }
    const srcDir = join(pkgDir, "src");
    if (!existsSync(srcDir)) {
        return false;
    }
    return newestTsMtime(srcDir) > statSync(out).mtimeMs;
}

/**
 * Rebuild a package via its `npm run build` when stale, streaming output to
 * this process's stdio. Exits the whole launcher on build failure so a
 * broken compile never silently runs stale code.
 *
 * @param {string} pkgDir Absolute path to the package directory.
 * @param {string} label Human label for the progress line.
 * @returns {void}
 */
function buildIfStale(pkgDir, label) {
    if (!needsRebuild(pkgDir)) {
        return;
    }
    console.error(`Building ${label}...`);
    const result = spawnSync("npm", ["run", "build"], { cwd: pkgDir, stdio: "inherit" });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

// shared first (host and plugins resolve it), then host, then each plugin —
// mirrors the old shell launcher's build order.
buildIfStale(join(ROOT, "shared"), "shared");
buildIfStale(join(ROOT, "host"), "host");
const pluginsDir = join(ROOT, "plugins");
if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const pkgDir = join(pluginsDir, entry.name);
        if (existsSync(join(pkgDir, "package.json"))) {
            buildIfStale(pkgDir, `plugin ${entry.name}`);
        }
    }
}

// Delegate to the production entry point, forwarding args verbatim (no args
// → citty prints the help tree). `stdio: "inherit"` plus the terminal's
// process group deliver Ctrl-C to the child; `familiar stop` targets the
// daemon's own pid via tmp/.daemon.pid, not this wrapper, so blocking in the
// foreground is correct for the long-running `start` daemon.
const child = spawnSync(
    "node",
    ["--enable-source-maps", join(ROOT, "cli", "bin", "familiar.mjs"), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, FAMILIAR_DEV: "1", FAMILIAR_HOME: ROOT } },
);
process.exit(child.status ?? 1);
