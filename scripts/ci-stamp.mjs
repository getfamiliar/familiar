// Stamp a single lockstep VERSION across all publishable workspace
// packages and rewrite internal `"*"` deps to the exact version, so the
// published packages resolve each other without a registry-published
// `*`. Also derives the `familiar` meta-package's bundled-plugin
// dependencies + `familiar.bundledPlugins` list from each plugin's
// `familiar.bundled` flag — the flag is the single source of truth.
//
// Runs in the CI working tree only (never committed back). Usage:
//   node scripts/ci-stamp.mjs <version>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`usage: node scripts/ci-stamp.mjs <version>  (got: ${version ?? "<nothing>"})`);
    process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** All workspace package directories (repo-relative), except the root. */
function packageDirs() {
    const dirs = ["shared", "host", "container", "cli"];
    const pluginsRoot = join(root, "plugins");
    for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(pluginsRoot, entry.name, "package.json"))) {
            dirs.push(join("plugins", entry.name));
        }
    }
    return dirs;
}

/** Pin any internal (`@getfamiliar/*` or `familiar`) dep pinned as `*` to the exact version. */
function pinInternal(deps) {
    if (!deps) {
        return;
    }
    for (const key of Object.keys(deps)) {
        if ((key.startsWith("@getfamiliar/") || key === "familiar") && deps[key] === "*") {
            deps[key] = version;
        }
    }
}

// First pass: read every manifest, collect the bundled plugin names from
// the `familiar.bundled` flags.
const manifests = new Map();
const bundledPlugins = [];
for (const dir of packageDirs()) {
    const path = join(root, dir, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    manifests.set(dir, { path, pkg });
    if (dir.startsWith("plugins/") && pkg.familiar?.bundled === true && pkg.name) {
        bundledPlugins.push(pkg.name);
    }
}
bundledPlugins.sort();

// Second pass: stamp versions, pin internal deps, wire the meta, and add
// a `repository` field (required for `npm publish --provenance`).
for (const [dir, { path, pkg }] of manifests) {
    pkg.version = version;
    pinInternal(pkg.dependencies);
    pinInternal(pkg.devDependencies);
    pinInternal(pkg.peerDependencies);
    pkg.repository = {
        type: "git",
        url: "git+https://github.com/getfamiliar/familiar.git",
        directory: dir,
    };
    if (pkg.name === "@getfamiliar/cli") {
        pkg.dependencies = pkg.dependencies ?? {};
        for (const name of bundledPlugins) {
            pkg.dependencies[name] = version;
        }
        pkg.familiar = { ...(pkg.familiar ?? {}), bundledPlugins };
    }
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`stamped ${pkg.name} @ ${version}`);
}
console.log(`bundled plugins: ${bundledPlugins.join(", ") || "(none)"}`);
