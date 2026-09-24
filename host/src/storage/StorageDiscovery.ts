import {
    type StorageDrive,
    type StorageDriveKind,
    StorageError,
    type StorageProvider,
} from "@getfamiliar/shared";
import type { MountConfig } from "./StorageConfig.js";
import type { StorageRegistry } from "./StorageRegistry.js";

/** Status of one row of `familiar storage list`. */
export type DiscoveryStatus =
    | "mounted"
    | "available"
    | "unreachable"
    | "auth-expired"
    | "unknown-account"
    | "error";

/** One row of `familiar storage list`. */
export interface DiscoveryRow {
    readonly status: DiscoveryStatus;
    readonly alias: string | null;
    readonly plugin: string;
    readonly account: string;
    readonly driveName: string | null;
    /** Exact value for a mount's `drive:` (`null` = primary drive). */
    readonly selector: string | null;
    readonly kind: StorageDriveKind | null;
    /** Configured access of a mount (`null` for discovered drives). */
    readonly access: string | null;
    /** Reason / hint (login command, error message). */
    readonly note: string | null;
}

/** Result of opening one configured mount. */
export interface MountProbe {
    readonly mount: MountConfig;
    readonly outcome:
        | { readonly ok: true; readonly drive: StorageDrive }
        | {
              readonly ok: false;
              readonly status: "unreachable" | "auth-expired" | "unknown-account";
              readonly reason: string;
          };
}

/** Drives discovered for one account, or why discovery failed. */
export interface AccountDiscovery {
    readonly plugin: string;
    readonly account: string;
    readonly drives?: readonly StorageDrive[];
    readonly error?: { readonly status: "auth-expired" | "error"; readonly reason: string };
}

/** Narrowing options (`--plugin`, `--account`, `--search`, `--limit`). */
export interface DiscoveryOptions {
    readonly plugin?: string;
    readonly account?: string;
    readonly search?: string;
    /** Max drives per account. */
    readonly limit: number;
}

/**
 * Merge probed mounts and discovered drives into list rows. Pure, so the
 * matching logic is testable without providers.
 *
 * - every mount becomes one row with its probe status;
 * - discovered drives not claimed by a mounted mount (same plugin,
 *   account and drive id) become `available` rows;
 * - accounts whose discovery failed get one `error` / `auth-expired`
 *   row, unless a mount of that account already reports the same.
 *
 * @param probes - One probe per configured mount.
 * @param discoveries - One entry per (plugin, account).
 * @returns Rows: mounts first (config order), then per-account rows.
 */
export function matchMountsToDrives(
    probes: readonly MountProbe[],
    discoveries: readonly AccountDiscovery[],
): DiscoveryRow[] {
    const rows: DiscoveryRow[] = [];
    const claimed = new Set<string>();
    for (const { mount, outcome } of probes) {
        if (outcome.ok) {
            claimed.add(driveKey(mount.plugin, mount.account, outcome.drive.id));
        }
        rows.push({
            status: outcome.ok ? "mounted" : outcome.status,
            alias: mount.alias,
            plugin: mount.plugin,
            account: mount.account,
            driveName: outcome.ok ? outcome.drive.name : null,
            selector: mount.drive,
            kind: outcome.ok ? outcome.drive.kind : null,
            access: mount.access,
            note: outcome.ok ? null : outcome.reason,
        });
    }
    for (const discovery of discoveries) {
        if (discovery.error) {
            const alreadyReported = rows.some(
                (r) =>
                    r.plugin === discovery.plugin &&
                    r.account === discovery.account &&
                    r.status === discovery.error?.status,
            );
            if (!alreadyReported) {
                rows.push({
                    status: discovery.error.status,
                    alias: null,
                    plugin: discovery.plugin,
                    account: discovery.account,
                    driveName: null,
                    selector: null,
                    kind: null,
                    access: null,
                    note: discovery.error.reason,
                });
            }
            continue;
        }
        for (const drive of discovery.drives ?? []) {
            if (claimed.has(driveKey(discovery.plugin, discovery.account, drive.id))) {
                continue;
            }
            rows.push({
                status: "available",
                alias: null,
                plugin: discovery.plugin,
                account: discovery.account,
                driveName: drive.name,
                selector: drive.selector,
                kind: drive.kind,
                access: null,
                note: null,
            });
        }
    }
    return rows;
}

/**
 * Query every storage provider: its accounts and their drives, and open
 * every configured mount. Failures are captured per account / mount,
 * never thrown.
 *
 * @param registry - Registered providers.
 * @param mounts - Configured mounts.
 * @param options - Narrowing options.
 * @returns The merged rows (see {@link matchMountsToDrives}).
 */
export async function discoverStorage(
    registry: StorageRegistry,
    mounts: readonly MountConfig[],
    options: DiscoveryOptions,
): Promise<DiscoveryRow[]> {
    const account = options.account?.toLowerCase();
    const providers = registry
        .all()
        .filter((p) => options.plugin === undefined || p.pluginId === options.plugin);
    const accountsByPlugin = new Map<string, readonly string[]>();
    const discoveries: AccountDiscovery[] = [];
    for (const provider of providers) {
        let accounts: readonly string[];
        try {
            accounts = await provider.listAccounts();
        } catch (err) {
            discoveries.push({
                plugin: provider.pluginId,
                account: "*",
                error: { status: "error", reason: describe(err) },
            });
            continue;
        }
        accountsByPlugin.set(provider.pluginId, accounts);
        for (const acc of accounts.filter((a) => account === undefined || a === account)) {
            discoveries.push(await discoverAccount(provider, acc, options));
        }
    }
    const probes: MountProbe[] = [];
    for (const mount of mounts) {
        if (options.plugin !== undefined && mount.plugin !== options.plugin) {
            continue;
        }
        if (account !== undefined && mount.account !== account) {
            continue;
        }
        probes.push({
            mount,
            outcome: await probeMount(registry.byPluginId(mount.plugin), mount, accountsByPlugin),
        });
    }
    return matchMountsToDrives(probes, discoveries);
}

/** List one account's drives, capturing failures. */
async function discoverAccount(
    provider: StorageProvider,
    account: string,
    options: DiscoveryOptions,
): Promise<AccountDiscovery> {
    try {
        const drives = await provider.listDrives(account, {
            limit: options.limit,
            search: options.search,
        });
        return { plugin: provider.pluginId, account, drives };
    } catch (err) {
        if (err instanceof StorageError && err.code === "AuthExpired") {
            return {
                plugin: provider.pluginId,
                account,
                error: {
                    status: "auth-expired",
                    reason: `login expired — run \`${provider.loginCommand(account)}\``,
                },
            };
        }
        return {
            plugin: provider.pluginId,
            account,
            error: { status: "error", reason: describe(err) },
        };
    }
}

/**
 * Open one configured mount and classify the outcome.
 *
 * @param provider - The mount's provider, if registered.
 * @param mount - The mount.
 * @param accountsByPlugin - Logged-in accounts per plugin (absent when listing failed).
 */
export async function probeMount(
    provider: StorageProvider | undefined,
    mount: MountConfig,
    accountsByPlugin: ReadonlyMap<string, readonly string[]>,
): Promise<MountProbe["outcome"]> {
    if (!provider) {
        return {
            ok: false,
            status: "unreachable",
            reason: `plugin "${mount.plugin}" provides no storage (not installed or disabled)`,
        };
    }
    const accounts = accountsByPlugin.get(mount.plugin);
    if (accounts !== undefined && !accounts.includes(mount.account)) {
        return {
            ok: false,
            status: "unknown-account",
            reason: `no ${mount.plugin} login for ${mount.account} — run \`${provider.loginCommand(mount.account)}\``,
        };
    }
    try {
        return { ok: true, drive: await provider.openDrive(mount.account, mount.drive) };
    } catch (err) {
        if (err instanceof StorageError && err.code === "AuthExpired") {
            return {
                ok: false,
                status: "auth-expired",
                reason: `login expired — run \`${provider.loginCommand(mount.account)}\``,
            };
        }
        return { ok: false, status: "unreachable", reason: describe(err) };
    }
}

/**
 * The `familiar storage add` command line for an available drive.
 *
 * @param row - An `available` row.
 */
export function addCommandFor(row: DiscoveryRow): string {
    const drive = row.selector !== null ? ` --drive ${shellQuote(row.selector)}` : "";
    return `familiar storage add ${row.plugin} ${row.account}${drive} --as <alias>`;
}

/** Quote for a POSIX shell when needed. */
function shellQuote(value: string): string {
    return /^[\w@./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function driveKey(plugin: string, account: string, driveId: string): string {
    return `${plugin}\u0000${account}\u0000${driveId}`;
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
