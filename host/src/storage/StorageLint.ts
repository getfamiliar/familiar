import { StorageError } from "@getfamiliar/shared";
import { normalizeRoot, type StorageLintFinding, type StorageSettings } from "./StorageConfig.js";
import { probeMount } from "./StorageDiscovery.js";
import type { StorageRegistry } from "./StorageRegistry.js";
import type { StorageService } from "./StorageService.js";

/** A missing write root that `--fix` can create. */
export interface MissingWriteRoot {
    readonly alias: string;
    readonly root: string;
}

/** Result of the online checks. */
export interface OnlineLintResult {
    readonly findings: readonly StorageLintFinding[];
    readonly missingRoots: readonly MissingWriteRoot[];
}

/** Drives inspected for "did you mean" suggestions. */
const SUGGESTION_SCAN_LIMIT = 200;

/**
 * Online checks (`familiar storage lint --online`): logins, drive
 * reachability (with close matches when a drive is missing) and the
 * existence of every write root. Whether the account lacks write
 * permission on a drive is not checked — Graph cannot tell without a
 * test write.
 *
 * @param service - Storage core (drive handles, path resolution).
 * @param registry - Registered providers.
 * @param settings - Parsed storage settings.
 * @returns Findings plus the write roots `--fix` may create.
 */
export async function lintStorageOnline(
    service: StorageService,
    registry: StorageRegistry,
    settings: StorageSettings,
): Promise<OnlineLintResult> {
    const findings: StorageLintFinding[] = [];
    const missingRoots: MissingWriteRoot[] = [];
    const accountsByPlugin = new Map<string, readonly string[]>();
    for (const provider of registry.all()) {
        try {
            accountsByPlugin.set(provider.pluginId, await provider.listAccounts());
        } catch (err) {
            findings.push({
                severity: "error",
                alias: null,
                message: `${provider.pluginId}: cannot list logins (${err instanceof Error ? err.message : String(err)})`,
            });
        }
    }
    for (const mount of settings.mounts) {
        const provider = registry.byPluginId(mount.plugin);
        const outcome = await probeMount(provider, mount, accountsByPlugin);
        if (!outcome.ok) {
            let message = outcome.reason;
            if (outcome.status === "unreachable" && provider && mount.drive !== null) {
                const suggestions = await closeMatches(provider, mount.account, mount.drive);
                if (suggestions.length > 0) {
                    message += ` — close matches: ${suggestions.map((s) => `"${s}"`).join(", ")}`;
                }
            }
            findings.push({ severity: "error", alias: mount.alias, message });
            continue;
        }
        if (mount.access !== "readwrite") {
            continue;
        }
        for (const root of mount.writeRoots) {
            try {
                const found = await service.stat(`${mount.alias}:${root}`);
                if (found.item.kind !== "folder") {
                    findings.push({
                        severity: "warning",
                        alias: mount.alias,
                        message: `write root ${root} is a ${found.item.kind}, not a folder`,
                    });
                }
            } catch (err) {
                if (hasCode(err, "NotFound")) {
                    findings.push({
                        severity: "warning",
                        alias: mount.alias,
                        message: `write root ${root} does not exist on the drive (\`familiar storage lint --online --fix\` creates it)`,
                    });
                    missingRoots.push({ alias: mount.alias, root });
                } else {
                    findings.push({
                        severity: "warning",
                        alias: mount.alias,
                        message: `cannot check write root ${root}: ${err instanceof Error ? err.message : String(err)}`,
                    });
                }
            }
        }
    }
    return { findings, missingRoots };
}

/**
 * Normalized `writeRoots` per mount where the configured list differs
 * (trailing slashes, `.` segments, duplicates). Input for `--fix`.
 *
 * @param raw - Raw `storage` group.
 * @returns Alias → normalized list, only for mounts that need a change.
 */
export function writeRootNormalizations(raw: unknown): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const mounts = (raw as { mounts?: unknown } | undefined)?.mounts;
    if (typeof mounts !== "object" || mounts === null) {
        return out;
    }
    for (const [alias, value] of Object.entries(mounts)) {
        const roots = (value as { writeRoots?: unknown } | null)?.writeRoots;
        if (
            !Array.isArray(roots) ||
            !roots.every((r) => typeof r === "string" && r.startsWith("/"))
        ) {
            continue;
        }
        const normalized = [...new Set((roots as string[]).map(normalizeRoot))];
        if (normalized.length !== roots.length || normalized.some((r, i) => r !== roots[i])) {
            out.set(alias, normalized);
        }
    }
    return out;
}

/**
 * Selectors of the account's drives that share a word with `wanted`.
 *
 * @returns Up to five selectors (`(primary)` for the default drive).
 */
async function closeMatches(
    provider: NonNullable<ReturnType<StorageRegistry["byPluginId"]>>,
    account: string,
    wanted: string,
): Promise<string[]> {
    const words = wanted
        .toLowerCase()
        .split(/[/\s_-]+/)
        .filter((w) => w.length > 2 && w !== "sites" && w !== "teams" && w !== "drives");
    try {
        const drives = await provider.listDrives(account, { limit: SUGGESTION_SCAN_LIMIT });
        return drives
            .filter((d) =>
                words.some((w) => `${d.selector ?? ""} ${d.name}`.toLowerCase().includes(w)),
            )
            .map((d) => d.selector ?? "(primary)")
            .slice(0, 5);
    } catch {
        return [];
    }
}

/** Whether `err` carries `code` (ToolError or StorageError). */
function hasCode(err: unknown, code: string): boolean {
    return (
        (err instanceof StorageError && err.code === code) ||
        (err instanceof Error && (err as { code?: unknown }).code === code)
    );
}
