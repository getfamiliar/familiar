import { posix } from "node:path";

/** Effective access of a mount. */
export type MountAccess = "read" | "readwrite";

/** One configured mount (`storage.mounts.<alias>`), with defaults applied. */
export interface MountConfig {
    readonly alias: string;
    readonly plugin: string;
    readonly account: string;
    /** Provider drive selector; `null` = the account's primary drive. */
    readonly drive: string | null;
    /** Configured access (effective only while `storage.allowWrite` is true). */
    readonly access: MountAccess;
    /** Normalized absolute path prefixes where mutations are allowed. */
    readonly writeRoots: readonly string[];
    readonly searchByDefault: boolean;
}

/** Parsed `storage` group. */
export interface StorageSettings {
    readonly allowWrite: boolean;
    readonly searchTimeoutMs: number;
    readonly runQuotaBytes: number;
    readonly mounts: readonly MountConfig[];
}

/** Severity of a lint finding. */
export type StorageLintSeverity = "error" | "warning" | "info";

/** One lint finding; `alias` is `null` for group-level findings. */
export interface StorageLintFinding {
    readonly severity: StorageLintSeverity;
    readonly alias: string | null;
    readonly message: string;
}

export const DEFAULT_WRITE_ROOTS: readonly string[] = ["/Familiar"];
export const DEFAULT_SEARCH_TIMEOUT_MS = 8000;
export const DEFAULT_RUN_QUOTA_MB = 200;

const GROUP_KEYS = new Set(["allowWrite", "searchTimeoutMs", "runQuotaMb", "mounts"]);
const MOUNT_KEYS = new Set([
    "plugin",
    "account",
    "drive",
    "access",
    "writeRoots",
    "searchByDefault",
]);

/** Characters that would break ref parsing (`mount:/path`, `mount#id`). */
const ALIAS_FORBIDDEN = /[:#/\s]/;

/**
 * Parse the raw `storage` config group into typed settings, applying the
 * secure defaults. Malformed mounts are skipped (the linter reports
 * them); a missing group yields no mounts and writes disabled.
 *
 * @param raw - The value of the `storage` key (may be `undefined`).
 * @returns The parsed settings.
 */
export function parseStorageSettings(raw: unknown): StorageSettings {
    const group = isPlainObject(raw) ? raw : {};
    const mountsRaw = isPlainObject(group.mounts) ? group.mounts : {};
    const mounts: MountConfig[] = [];
    for (const [alias, value] of Object.entries(mountsRaw)) {
        const mount = parseMount(alias, value);
        if (mount) {
            mounts.push(mount);
        }
    }
    const quotaMb =
        typeof group.runQuotaMb === "number" && group.runQuotaMb > 0
            ? group.runQuotaMb
            : DEFAULT_RUN_QUOTA_MB;
    return {
        allowWrite: group.allowWrite === true,
        searchTimeoutMs:
            typeof group.searchTimeoutMs === "number" && group.searchTimeoutMs > 0
                ? group.searchTimeoutMs
                : DEFAULT_SEARCH_TIMEOUT_MS,
        runQuotaBytes: Math.round(quotaMb * 1024 * 1024),
        mounts,
    };
}

/**
 * Parse one mount entry, or `null` when it is structurally unusable
 * (bad alias, missing plugin / account).
 */
function parseMount(alias: string, value: unknown): MountConfig | null {
    if (!isValidAlias(alias) || !isPlainObject(value)) {
        return null;
    }
    if (!isNonEmptyString(value.plugin) || !isNonEmptyString(value.account)) {
        return null;
    }
    const roots = Array.isArray(value.writeRoots)
        ? value.writeRoots.filter(isNonEmptyString).filter((r) => r.startsWith("/"))
        : DEFAULT_WRITE_ROOTS;
    return {
        alias,
        plugin: value.plugin,
        account: value.account.toLowerCase(),
        drive: isNonEmptyString(value.drive) ? value.drive : null,
        access: value.access === "readwrite" ? "readwrite" : "read",
        writeRoots: dedupe(roots.map(normalizeRoot)),
        searchByDefault: value.searchByDefault !== false,
    };
}

/**
 * Whether `alias` can be used as a mount alias (non-empty, no `:`, `#`,
 * `/` or whitespace).
 */
export function isValidAlias(alias: string): boolean {
    return alias.length > 0 && !ALIAS_FORBIDDEN.test(alias);
}

/**
 * Normalize a write root: collapse duplicate slashes, resolve `.`,
 * strip a trailing slash (except for `/`).
 *
 * @param root - Absolute path.
 * @returns The normalized path.
 */
export function normalizeRoot(root: string): string {
    const normalized = posix.normalize(root);
    return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * Static (offline) checks over the raw `storage` group. Shared by the
 * startup lint, `config lint` and `familiar storage lint`.
 *
 * @param raw - The value of the `storage` key.
 * @param options.knownPlugins - Plugin ids that registered a storage
 *   provider; when given, unknown `plugin:` values are errors.
 * @returns All findings, in config order.
 */
export function lintStorageStatic(
    raw: unknown,
    options: { readonly knownPlugins?: readonly string[] } = {},
): StorageLintFinding[] {
    const findings: StorageLintFinding[] = [];
    if (raw === undefined || raw === null) {
        return findings;
    }
    const error = (alias: string | null, message: string): void => {
        findings.push({ severity: "error", alias, message });
    };
    const warning = (alias: string | null, message: string): void => {
        findings.push({ severity: "warning", alias, message });
    };
    const info = (alias: string | null, message: string): void => {
        findings.push({ severity: "info", alias, message });
    };

    if (!isPlainObject(raw)) {
        error(null, "`storage` must be a mapping");
        return findings;
    }
    for (const key of Object.keys(raw)) {
        if (!GROUP_KEYS.has(key)) {
            error(null, `unknown key \`storage.${key}\``);
        }
    }
    if (raw.allowWrite !== undefined && typeof raw.allowWrite !== "boolean") {
        error(null, "`storage.allowWrite` must be a boolean (true / false)");
    }
    for (const key of ["searchTimeoutMs", "runQuotaMb"] as const) {
        const value = raw[key];
        if (value !== undefined && (typeof value !== "number" || value <= 0)) {
            error(null, `\`storage.${key}\` must be a positive number`);
        }
    }
    const allowWrite = raw.allowWrite === true;
    if (raw.mounts === undefined || raw.mounts === null) {
        return findings;
    }
    if (!isPlainObject(raw.mounts)) {
        error(null, "`storage.mounts` must be a mapping of alias → mount");
        return findings;
    }

    const seenTargets = new Map<string, string>();
    const seenAliases = new Map<string, string>();
    for (const [alias, value] of Object.entries(raw.mounts)) {
        const lower = alias.toLowerCase();
        const clash = seenAliases.get(lower);
        if (clash !== undefined) {
            error(alias, `duplicate alias (differs from "${clash}" only in case)`);
        }
        seenAliases.set(lower, alias);
        if (!isValidAlias(alias)) {
            error(alias, "alias must not be empty or contain `:`, `#`, `/` or whitespace");
        }
        if (!isPlainObject(value)) {
            error(alias, "mount must be a mapping");
            continue;
        }
        for (const key of Object.keys(value)) {
            if (!MOUNT_KEYS.has(key)) {
                error(alias, `unknown key \`${key}\``);
            }
        }
        if (!isNonEmptyString(value.plugin)) {
            error(alias, "`plugin` is required (a provider plugin id, e.g. ms365)");
        } else if (options.knownPlugins && !options.knownPlugins.includes(value.plugin)) {
            const known =
                options.knownPlugins.length > 0 ? options.knownPlugins.join(", ") : "none";
            error(alias, `unknown storage plugin "${value.plugin}" (installed: ${known})`);
        }
        if (!isNonEmptyString(value.account)) {
            error(alias, "`account` is required (e.g. the login's e-mail / UPN)");
        }
        if (value.drive !== undefined && value.drive !== null && typeof value.drive !== "string") {
            error(alias, "`drive` must be a string");
        }
        if (value.access !== undefined && value.access !== "read" && value.access !== "readwrite") {
            error(
                alias,
                `\`access\` must be "read" or "readwrite" (got ${JSON.stringify(value.access)})`,
            );
        }
        if (value.searchByDefault !== undefined && typeof value.searchByDefault !== "boolean") {
            error(alias, "`searchByDefault` must be a boolean");
        }
        const access = value.access === "readwrite" ? "readwrite" : "read";
        if (access === "readwrite" && !allowWrite) {
            info(alias, "`access: readwrite` has no effect while `storage.allowWrite` is false");
        }
        if (value.writeRoots !== undefined) {
            lintWriteRoots(alias, value.writeRoots, access, findings);
        }
        if (isNonEmptyString(value.plugin) && isNonEmptyString(value.account)) {
            const target = `${value.plugin}\u0000${value.account.toLowerCase()}\u0000${typeof value.drive === "string" ? value.drive : ""}`;
            const other = seenTargets.get(target);
            if (other !== undefined) {
                warning(alias, `same plugin / account / drive as mount "${other}"`);
            } else {
                seenTargets.set(target, alias);
            }
        }
    }
    return findings;
}

/** Checks for one mount's `writeRoots`. */
function lintWriteRoots(
    alias: string,
    raw: unknown,
    access: MountAccess,
    findings: StorageLintFinding[],
): void {
    if (!Array.isArray(raw) || !raw.every((r) => typeof r === "string")) {
        findings.push({
            severity: "error",
            alias,
            message: "`writeRoots` must be a list of paths",
        });
        return;
    }
    if (access === "read") {
        findings.push({
            severity: "warning",
            alias,
            message: "`writeRoots` has no effect with `access: read`",
        });
    }
    const normalized: string[] = [];
    for (const root of raw as string[]) {
        if (!root.startsWith("/")) {
            findings.push({
                severity: "error",
                alias,
                message: `write root "${root}" must be absolute (start with /)`,
            });
            continue;
        }
        if (root.split("/").includes("..")) {
            findings.push({
                severity: "warning",
                alias,
                message: `write root "${root}" contains ".."`,
            });
        }
        const norm = normalizeRoot(root);
        if (norm !== root) {
            findings.push({
                severity: "warning",
                alias,
                message: `write root "${root}" is not normalized (use "${norm}")`,
            });
        }
        if (norm === "/") {
            findings.push({
                severity: "warning",
                alias,
                message: 'write root "/" makes the whole drive writable',
            });
        }
        if (normalized.includes(norm)) {
            findings.push({
                severity: "warning",
                alias,
                message: `duplicate write root "${norm}"`,
            });
            continue;
        }
        normalized.push(norm);
    }
    for (const a of normalized) {
        for (const b of normalized) {
            if (a !== b && isPathInside(b, a)) {
                findings.push({
                    severity: "warning",
                    alias,
                    message: `write root "${b}" is nested in "${a}"`,
                });
            }
        }
    }
}

/**
 * Whether `child` equals `root` or lies below it (case-insensitive, as
 * OneDrive, Dropbox and SharePoint paths are).
 *
 * @param child - Normalized absolute path.
 * @param root - Normalized absolute path.
 */
export function isPathInside(child: string, root: string): boolean {
    const c = child.toLowerCase();
    const r = root.toLowerCase();
    if (r === "/") {
        return true;
    }
    return c === r || c.startsWith(`${r}/`);
}

/** Type guard for plain mappings. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Type guard for non-empty strings. */
function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/** Order-preserving de-duplication. */
function dedupe(values: readonly string[]): string[] {
    return [...new Set(values)];
}
