import { refreshTokens } from "./PkceLogin.js";
import type { TeslaTokens, TokenStore } from "./TokenStore.js";

/**
 * Refresh this long before the recorded expiry rather than waiting for
 * a 401. Covers clock skew and a slow request that starts valid and
 * lands expired.
 */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Owner of the single Tesla login: hands out a currently-valid access
 * token and refreshes it transparently when it has aged out.
 *
 * Every API client takes a `() => Promise<string>` token provider
 * rather than a token value (the shape ms365's `GraphClient` uses), so
 * a refresh in the middle of a long-running tool call is invisible to
 * the call site.
 *
 * Concurrent callers share one in-flight refresh: the pending promise
 * is memoised so a burst of tool calls after a daemon restart does not
 * fire N parallel refreshes — Tesla's SSO is rate-limited and a
 * rotated refresh token would invalidate the losers.
 */
export class TeslaAuth {
    private readonly store: TokenStore;
    private tokens: TeslaTokens | null = null;
    private pendingRefresh: Promise<TeslaTokens> | null = null;

    constructor(store: TokenStore) {
        this.store = store;
    }

    /**
     * Load the persisted tokens into memory. Idempotent; call it once
     * at daemon boot or lazily before the first token handout.
     *
     * @returns The loaded tokens, or `null` when no login is cached.
     */
    async load(): Promise<TeslaTokens | null> {
        this.tokens = await this.store.read();
        return this.tokens;
    }

    /**
     * Whether a login is cached. Does not prove the refresh token is
     * still alive — only {@link getAccessToken} can.
     *
     * @returns True when tokens have been loaded.
     */
    hasTokens(): boolean {
        return this.tokens !== null;
    }

    /** The in-memory token set, or `null` before {@link load} / after a failed one. */
    get current(): TeslaTokens | null {
        return this.tokens;
    }

    /**
     * Return a usable Owner API bearer token, refreshing first when the
     * cached one is at or past its expiry margin.
     *
     * @returns A valid access token.
     * @throws When no login is cached or the refresh token is dead —
     *   both mean "run `familiar tesla login`", and the message says so.
     */
    async getAccessToken(): Promise<string> {
        if (this.tokens === null) {
            await this.load();
        }
        const tokens = this.tokens;
        if (tokens === null) {
            throw new Error("no Tesla login cached; run `familiar tesla login`");
        }
        if (tokens.accessToken.length > 0 && Date.now() < tokens.expiresAt - EXPIRY_MARGIN_MS) {
            return tokens.accessToken;
        }
        const refreshed = await this.refreshOnce(tokens);
        return refreshed.accessToken;
    }

    /**
     * Force a refresh regardless of the recorded expiry. Used by the
     * daemon's boot probe and by `familiar tesla status` to prove the
     * refresh token still works.
     *
     * @returns The refreshed token set.
     * @throws When no login is cached or Tesla refuses the refresh.
     */
    async forceRefresh(): Promise<TeslaTokens> {
        if (this.tokens === null) {
            await this.load();
        }
        const tokens = this.tokens;
        if (tokens === null) {
            throw new Error("no Tesla login cached; run `familiar tesla login`");
        }
        return this.refreshOnce(tokens);
    }

    /**
     * Refresh, collapsing concurrent callers onto a single in-flight
     * request and persisting the result.
     *
     * @param tokens The current token set whose refresh token to present.
     * @returns The refreshed token set.
     */
    private async refreshOnce(tokens: TeslaTokens): Promise<TeslaTokens> {
        if (this.pendingRefresh !== null) {
            return this.pendingRefresh;
        }
        const pending = refreshTokens(tokens.refreshToken, tokens.email).then(async (next) => {
            await this.store.write(next);
            this.tokens = next;
            return next;
        });
        this.pendingRefresh = pending;
        try {
            return await pending;
        } finally {
            this.pendingRefresh = null;
        }
    }
}
