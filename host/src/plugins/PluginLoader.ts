import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger, PluginManifest } from "@getfamiliar/shared";
import type { Bootstrap } from "../Bootstrap.js";

/**
 * The subset of a package.json this loader reads. `familiar.bundled`
 * marks a first-party plugin as prebundled core; `familiar.bundledPlugins`
 * is the CI-generated list carried by the `familiar` meta-package.
 */
interface FamiliarPackageJson {
    readonly name?: string;
    readonly familiar?: {
        readonly bundled?: boolean;
        readonly bundledPlugins?: readonly string[];
    };
}

/**
 * Read and parse a package.json, returning null when it's missing or
 * malformed (callers log and skip rather than crash the whole host over
 * one bad plugin).
 *
 * @param path Absolute path to the package.json.
 * @returns The parsed manifest, or null on any read/parse failure.
 */
function readPackageJson(path: string): FamiliarPackageJson | null {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as FamiliarPackageJson;
    } catch {
        return null;
    }
}

/**
 * Discover the prebundled (always-on) plugin package names. In a monorepo
 * checkout (`<homeDir>/plugins/` exists) this reads each workspace
 * plugin's `familiar.bundled` flag directly, so the flag is the live
 * source of truth during development. Once installed, the CI-generated
 * `familiar.bundledPlugins` list on the `@getfamiliar/cli` meta-package is
 * read instead — no first-party name-pattern scan of node_modules.
 *
 * @param boot Bootstrap providing the home dir.
 * @param req Require function anchored at the project, used to locate the meta-package.
 * @param log Logger for diagnostics.
 * @returns Package names of the bundled plugins (possibly empty).
 */
function discoverBundled(boot: Bootstrap, req: NodeRequire, log: Logger): string[] {
    const pluginsDir = join(boot.homeDir, "plugins");
    if (existsSync(pluginsDir)) {
        const out: string[] = [];
        for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const pkg = readPackageJson(join(pluginsDir, entry.name, "package.json"));
            if (pkg?.familiar?.bundled === true && pkg.name) {
                out.push(pkg.name);
            }
        }
        return out;
    }
    try {
        const pkg = readPackageJson(req.resolve("@getfamiliar/cli/package.json"));
        return [...(pkg?.familiar?.bundledPlugins ?? [])];
    } catch {
        log.warn(
            "@getfamiliar/cli meta-package not resolvable from the project; no bundled plugins will load",
        );
        return [];
    }
}

/**
 * Read the `config/plugins` whitelist — one package specifier per line,
 * with `#` comments and blank lines ignored. This is the explicit,
 * third-party-friendly surface for optional plugins (any package name,
 * not just `@getfamiliar/*`). Missing file → empty list.
 *
 * @param boot Bootstrap providing the home dir.
 * @returns The listed package specifiers, in file order.
 */
function readWhitelist(boot: Bootstrap): string[] {
    const path = join(boot.homeDir, "config", "plugins");
    if (!existsSync(path)) {
        return [];
    }
    return readFileSync(path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Resolve and import one plugin by package specifier, returning its
 * `definePlugin` default export. Resolution is anchored at the project's
 * node_modules; on failure it falls back to the host package's own
 * node_modules (covers a global `npm i -g familiar` install). Any
 * failure logs and returns null so one broken plugin can't take the host
 * down.
 *
 * @param name Package specifier to import.
 * @param req Require anchored at the project.
 * @param log Logger for diagnostics.
 * @returns The plugin manifest, or null when it can't be loaded.
 */
async function importPlugin(
    name: string,
    req: NodeRequire,
    log: Logger,
): Promise<PluginManifest | null> {
    let resolved: string;
    try {
        resolved = req.resolve(name);
    } catch {
        try {
            resolved = createRequire(import.meta.url).resolve(name);
        } catch {
            log.warn(`plugin "${name}" is listed but not installed — skipping`);
            return null;
        }
    }
    try {
        const mod = (await import(pathToFileURL(resolved).href)) as {
            default?: PluginManifest;
        };
        if (!mod.default || typeof mod.default.id !== "string") {
            log.warn(`plugin "${name}" has no valid definePlugin() default export — skipping`);
            return null;
        }
        return mod.default;
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        log.warn(`failed to load plugin "${name}": ${cause}`);
        return null;
    }
}

/** The two name sources feeding the active plugin set. */
export interface PluginSources {
    /** Prebundled core plugin package names (always on). */
    readonly bundled: string[];
    /** Optional/third-party package names from the `config/plugins` whitelist. */
    readonly whitelisted: string[];
}

/**
 * Collect the plugin package names from both sources without importing
 * them — the prebundled core set ({@link discoverBundled}) and the
 * `config/plugins` whitelist ({@link readWhitelist}). Used by
 * {@link loadPlugins} and by `familiar plugin list`.
 *
 * @param boot Bootstrap providing the home dir.
 * @param log Logger for diagnostics.
 * @returns The bundled and whitelisted package names.
 */
export function pluginSources(boot: Bootstrap, log: Logger): PluginSources {
    const req = createRequire(pathToFileURL(join(boot.homeDir, "package.json")));
    return { bundled: discoverBundled(boot, req, log), whitelisted: readWhitelist(boot) };
}

/**
 * Load the active plugins for this project. The active set is the union
 * of the prebundled core plugins ({@link discoverBundled}) and the
 * `config/plugins` whitelist ({@link readWhitelist}), resolved and
 * imported from the project's node_modules and deduped by manifest id.
 *
 * Replaces the former static `Registry.ts` array: plugin-ness is no
 * longer a compile-time import list but a runtime union of an explicit
 * per-plugin `familiar.bundled` flag and a user-editable whitelist, so
 * third-party plugins are first-class.
 *
 * @param boot Bootstrap providing the home dir and asset root.
 * @param log Logger for load diagnostics.
 * @returns The loaded plugin manifests, in load order.
 */
export async function loadPlugins(boot: Bootstrap, log: Logger): Promise<PluginManifest[]> {
    const req = createRequire(pathToFileURL(join(boot.homeDir, "package.json")));
    const { bundled, whitelisted } = pluginSources(boot, log);
    const names = [...new Set([...bundled, ...whitelisted])];
    const out: PluginManifest[] = [];
    const seenIds = new Set<string>();
    for (const name of names) {
        const manifest = await importPlugin(name, req, log);
        if (!manifest) {
            continue;
        }
        if (seenIds.has(manifest.id)) {
            log.warn(`duplicate plugin id "${manifest.id}" from "${name}" — ignored`);
            continue;
        }
        seenIds.add(manifest.id);
        out.push(manifest);
    }
    log.info(`loaded ${out.length} plugin(s): ${out.map((p) => p.id).join(", ") || "none"}`);
    return out;
}
