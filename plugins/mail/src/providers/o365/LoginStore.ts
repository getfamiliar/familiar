import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { AppRegistration } from "./AppRegistration.js";
import { type AccountSummary, GraphAuth } from "./GraphAuth.js";

/**
 * Result of validating one login at boot. `auth` is the live
 * {@link GraphAuth} ready for daemon use when `ok` is `true`; `reason`
 * carries the silent-acquire error message when `ok` is `false`.
 */
export interface LoginValidation {
    readonly upn: string;
    readonly ok: boolean;
    readonly auth: GraphAuth;
    readonly account: AccountSummary | null;
    readonly reason: string | null;
}

/**
 * Filesystem-backed registry of all currently-known o365 logins.
 *
 * Source of truth is the directory `data/mail/o365/`: one
 * `<upn>.json` file per logged-in account, written by msal-node's
 * cache plugin (see {@link GraphAuth}). The store enumerates files at
 * construction, lazily instantiates `GraphAuth` instances against
 * each, and offers a `validateAll()` pass that the daemon runs at
 * boot to weed out logins whose refresh token has died.
 *
 * Adding a login is just "write the cache file" — typically through
 * `GraphAuth.loginByDeviceCode()` from the `mail o365 login` CLI
 * command. Removing a login means deleting the file.
 */
export class LoginStore {
    private readonly directory: string;
    private readonly registration: AppRegistration;
    private auths: Map<string, GraphAuth> = new Map();

    constructor(directory: string, registration: AppRegistration) {
        this.directory = directory;
        this.registration = registration;
    }

    /**
     * Scan the login directory and (re)populate the in-memory map of
     * `upn → GraphAuth`. Idempotent — call any time the store may
     * have gone stale (e.g. after a CLI `login` from another process).
     *
     * Files that don't match `<something>.json` are ignored. The UPN
     * is taken verbatim from the filename stem; msal-node persists the
     * authoritative UPN inside the cache JSON, so a misnamed file is
     * mostly cosmetic — but we still rely on the stem for the active
     * filename, so a `login` flow always writes the stem to match the
     * authenticated account.
     */
    async refresh(): Promise<void> {
        if (!existsSync(this.directory)) {
            this.auths = new Map();
            return;
        }
        const entries = await fs.readdir(this.directory);
        const next = new Map<string, GraphAuth>();
        for (const entry of entries) {
            if (!entry.endsWith(".json") || entry.endsWith(".tmp")) {
                continue;
            }
            // Reserved filename owned by `DeltaCursorStore` — same directory,
            // not a login cache.
            if (entry === "delta.json") {
                continue;
            }
            // The on-disk filename may carry mixed-case UPN bytes from
            // an older login (pre-lowercase-normalization); the
            // in-memory key is always folded so lookups by UPN are
            // unambiguous. The cache file itself is left in place —
            // msal-node doesn't care about the filename, only the
            // contents.
            const upn = entry.slice(0, -".json".length).toLowerCase();
            if (upn.length === 0) {
                continue;
            }
            const cachePath = path.join(this.directory, entry);
            const existing = this.auths.get(upn);
            if (existing && existing.cacheFile === cachePath) {
                next.set(upn, existing);
                continue;
            }
            next.set(upn, new GraphAuth(cachePath, this.registration));
        }
        this.auths = next;
    }

    /**
     * Synchronous snapshot of known logins, in arbitrary stable order.
     * `refresh()` should have been called once before relying on this.
     */
    list(): readonly { upn: string; auth: GraphAuth }[] {
        return [...this.auths.entries()].map(([upn, auth]) => ({ upn, auth }));
    }

    /**
     * Lookup by UPN. Returns `undefined` when no login is cached for
     * that account. The supplied UPN is case-folded so callers
     * don't have to match the cached casing — `Alice@org.com` and
     * `alice@org.com` resolve to the same entry.
     */
    byUpn(upn: string): GraphAuth | undefined {
        return this.auths.get(upn.toLowerCase());
    }

    /**
     * Register a brand-new login. Called from the `mail o365 login`
     * CLI after `GraphAuth.loginByDeviceCode()` writes the cache file.
     * Idempotent — re-registering the same UPN replaces the entry.
     */
    add(upn: string, auth: GraphAuth): void {
        this.auths.set(upn.toLowerCase(), auth);
    }

    /**
     * Probe every known login with a silent token acquire. Failures
     * are reported in the result — never thrown — so the daemon can
     * log and skip per the memory rule
     * [[feedback_skip_broken_logins_over_exit]].
     */
    async validateAll(): Promise<readonly LoginValidation[]> {
        const out: LoginValidation[] = [];
        for (const { upn, auth } of this.list()) {
            try {
                await auth.getAccessTokenSilent();
                const account = await auth.getAccount();
                out.push({ upn, auth, account, ok: true, reason: null });
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                out.push({ upn, auth, account: null, ok: false, reason });
            }
        }
        return out;
    }

    /** Absolute path of the login directory. Used by the CLI for messages. */
    get directoryPath(): string {
        return this.directory;
    }
}

/**
 * Resolve the on-disk login directory for the plugin: `<dataDir>/mail/o365/`.
 * Centralised so both the daemon and the CLI agree on the layout.
 */
export function loginDirectory(dataDir: string): string {
    return path.join(dataDir, "mail", "o365");
}
