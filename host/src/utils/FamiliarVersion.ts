import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Cached result of {@link readFamiliarVersion}. */
let cachedVersion: string | null = null;

/**
 * Version of the running familiar host: the `version` of
 * `@getfamiliar/host`'s package.json (stamped by the release workflow).
 * Resolved relative to this module, which sits at
 * `<host>/{src,build}/utils/`. Read once per process.
 *
 * @returns The version, e.g. `0.4.2`.
 * @throws {Error} When the package.json is unreadable or has no version.
 */
export function readFamiliarVersion(): string {
    if (cachedVersion !== null) {
        return cachedVersion;
    }
    const packageFile = fileURLToPath(new URL("../../package.json", import.meta.url));
    const parsed = JSON.parse(readFileSync(packageFile, "utf8")) as { version?: unknown };
    if (typeof parsed.version !== "string" || parsed.version === "") {
        throw new Error(`${packageFile} has no version`);
    }
    cachedVersion = parsed.version;
    return cachedVersion;
}
