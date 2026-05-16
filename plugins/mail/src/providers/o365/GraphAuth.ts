import { promises as fs } from "node:fs";
import path from "node:path";
import {
    type AccountInfo,
    type ICachePlugin,
    PublicClientApplication,
    type TokenCacheContext,
} from "@azure/msal-node";
import { type AppRegistration, authorityUrl, GRAPH_SCOPES } from "./AppRegistration.js";

/**
 * Information about a logged-in account as seen by the plugin. Lifted
 * out of msal's `AccountInfo` so callers don't drag the SDK type
 * through their signatures.
 */
export interface AccountSummary {
    /** User Principal Name (e.g. `user@contoso.com`); the cache file's stem. */
    readonly upn: string;
    /** Display name from the home tenant, when msal-node has one. */
    readonly displayName: string | null;
    /** Home tenant id of the account. */
    readonly tenantId: string | null;
}

/**
 * Per-UPN MSAL wrapper. Owns one `PublicClientApplication` against a
 * single token-cache file (`data/mail/o365/<upn>.json`, mode 0o600).
 *
 * Two acquire paths:
 *
 * - {@link getAccessTokenSilent} — uses the cached refresh token. Throws
 *   when the cache is empty / the refresh token is dead. Daemons call
 *   this and treat the throw as "skip this login" (see the memory rule
 *   [[feedback_skip_broken_logins_over_exit]]).
 * - {@link loginByDeviceCode} — runs the device-code flow against the
 *   configured app, awaits user completion, writes the cache atomically.
 *   Only called from the CLI's `mail o365 login` subcommand.
 *
 * The cache file is the source of truth: deleting it logs the user out
 * for that UPN. `LoginStore` enumerates files in the directory to
 * surface available logins.
 */
export class GraphAuth {
    private readonly app: PublicClientApplication;
    private readonly cachePath: string;
    private readonly registration: AppRegistration;
    private cachedAccount: AccountInfo | null = null;

    constructor(cachePath: string, registration: AppRegistration) {
        this.cachePath = cachePath;
        this.registration = registration;
        this.app = new PublicClientApplication({
            auth: {
                clientId: registration.clientId,
                authority: authorityUrl(registration.tenantId),
            },
            cache: { cachePlugin: makeCachePlugin(cachePath) },
        });
    }

    /**
     * Acquire an access token using the cached refresh token. No user
     * interaction. Throws when no account is in the cache or when the
     * refresh token is expired / revoked.
     *
     * The first call also seeds {@link cachedAccount}; subsequent calls
     * reuse it, so we don't re-walk the cache for every poll iteration.
     */
    async getAccessTokenSilent(): Promise<string> {
        const account = await this.ensureAccount();
        const result = await this.app.acquireTokenSilent({
            account,
            scopes: [...GRAPH_SCOPES],
        });
        if (!result || result.accessToken.length === 0) {
            throw new Error(`acquireTokenSilent returned no access token for ${account.username}`);
        }
        return result.accessToken;
    }

    /**
     * Run the device-code flow, awaiting user completion. The
     * `deviceCodeCallback` argument is called once with the
     * "go to https://… and enter code XYZ" message — the CLI prints
     * it; a future web UI would render it differently. Writes the
     * cache atomically via the configured plugin once the user
     * completes the flow.
     */
    async loginByDeviceCode(
        deviceCodeCallback: (message: string) => void,
    ): Promise<AccountSummary> {
        const result = await this.app.acquireTokenByDeviceCode({
            scopes: [...GRAPH_SCOPES],
            deviceCodeCallback: (response) => deviceCodeCallback(response.message),
        });
        if (!result?.account) {
            throw new Error("device-code flow returned no account");
        }
        this.cachedAccount = result.account;
        return toSummary(result.account);
    }

    /**
     * Return the account summary for the cached login, or `null` when
     * the cache file has no usable account on it. Used by the CLI's
     * `status` command to surface "✓ user@org / ✗ user@org: <reason>"
     * without forcing a silent-acquire round trip.
     */
    async getAccount(): Promise<AccountSummary | null> {
        const account = await this.findAccount();
        return account ? toSummary(account) : null;
    }

    /** Absolute path of the backing cache file. */
    get cacheFile(): string {
        return this.cachePath;
    }

    /** The app registration in use (default or config-overridden). */
    get app_registration(): AppRegistration {
        return this.registration;
    }

    private async ensureAccount(): Promise<AccountInfo> {
        if (this.cachedAccount) {
            return this.cachedAccount;
        }
        const account = await this.findAccount();
        if (!account) {
            throw new Error(
                `no account in token cache ${this.cachePath} — run \`./cli.sh mail o365 login\``,
            );
        }
        this.cachedAccount = account;
        return account;
    }

    private async findAccount(): Promise<AccountInfo | null> {
        const accounts = await this.app.getTokenCache().getAllAccounts();
        if (accounts.length === 0) {
            return null;
        }
        return accounts[0];
    }
}

/**
 * Build the msal-node cache plugin that reads + writes the JSON cache
 * file. Persists with `mode 0o600` so a refresh token can't be read by
 * any other user on the box; atomic write via tmp file + rename so a
 * crashed write never leaves a half-serialized cache behind.
 */
function makeCachePlugin(cachePath: string): ICachePlugin {
    return {
        async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
            try {
                const data = await fs.readFile(cachePath, "utf-8");
                ctx.tokenCache.deserialize(data);
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw err;
                }
                // First run for this UPN — cache file doesn't exist yet.
            }
        },
        async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
            if (!ctx.cacheHasChanged) {
                return;
            }
            await fs.mkdir(path.dirname(cachePath), { recursive: true });
            const serialized = ctx.tokenCache.serialize();
            const tmp = `${cachePath}.tmp`;
            await fs.writeFile(tmp, serialized, { mode: 0o600 });
            await fs.rename(tmp, cachePath);
        },
    };
}

/**
 * Convert msal's `AccountInfo` into the plugin's public
 * {@link AccountSummary}. The UPN is folded to lowercase so every
 * downstream consumer (login-store keys, on-disk filenames, event
 * payload, rules-file lookups in the workspace) sees the same form —
 * SMTP folds the domain anyway and every mainstream provider folds
 * the local part too. Display name keeps its original casing because
 * it's prompt-text, not a key.
 */
function toSummary(account: AccountInfo): AccountSummary {
    return {
        upn: account.username.toLowerCase(),
        displayName: account.name ?? null,
        tenantId: account.tenantId ?? null,
    };
}
