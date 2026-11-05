import { createHash, randomBytes } from "node:crypto";
import type { PostgresConnection } from "@getfamiliar/shared";

/** One webserver session, as listed and looked up. */
export interface WebSession {
    readonly id: string;
    readonly login: string;
    readonly userAgent: string | null;
    readonly createdAt: Date;
    readonly lastSeenAt: Date;
    readonly expiresAt: Date;
}

/**
 * Persistence of one-time login tokens and sessions. Callers only ever
 * see raw tokens; implementations store hashes.
 */
export interface WebSessionStore {
    /**
     * Mint a one-time login token for `login`.
     *
     * @param login Login the redeemed session belongs to.
     * @param ttlMs Lifetime of the token.
     * @returns The raw token (goes into the login link).
     */
    createLoginToken(login: string, ttlMs: number): Promise<string>;
    /**
     * Consume a login token atomically.
     *
     * @param token Raw token from the link.
     * @returns The login, or null when unknown, used or expired.
     */
    redeemLoginToken(token: string): Promise<string | null>;
    /**
     * Create a session.
     *
     * @param login Login of the session.
     * @param userAgent Browser user agent, for `familiar web sessions list`.
     * @param ttlMs Lifetime of the session.
     * @returns The raw session token (goes into the cookie).
     */
    createSession(login: string, userAgent: string | null, ttlMs: number): Promise<string>;
    /**
     * Look up a live session and record the access.
     *
     * @param token Raw token from the cookie.
     * @returns The session, or null when unknown or expired.
     */
    findSession(token: string): Promise<WebSession | null>;
    /**
     * Delete the session with this raw token (logout). No-op when unknown.
     *
     * @param token Raw token from the cookie.
     */
    deleteSessionByToken(token: string): Promise<void>;
    /**
     * List live sessions, newest first.
     *
     * @returns The sessions.
     */
    listSessions(): Promise<readonly WebSession[]>;
    /**
     * Revoke one session by its full id, or every session.
     *
     * @param target A session id from {@link listSessions}, or `"all"`.
     * @returns Number of revoked sessions.
     */
    revokeSessions(target: string): Promise<number>;
}

/** Number of random bytes in a login or session token (256 bit). */
const TOKEN_BYTES = 32;

/**
 * Generate a random URL- and cookie-safe token.
 *
 * @returns A base64url string.
 */
export function generateToken(): string {
    return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * @param token Raw token.
 * @returns Hex sha256 of the token, the stored form.
 */
export function hashToken(token: string): string {
    return createHash("sha256").update(token, "utf-8").digest("hex");
}

/** Raw `web_sessions` row. */
interface RawSessionRow {
    id: string;
    login: string;
    user_agent: string | null;
    created_at: Date;
    last_seen_at: Date;
    expires_at: Date;
}

/**
 * @param row Raw row.
 * @returns The session.
 */
function toSession(row: RawSessionRow): WebSession {
    return {
        id: row.id,
        login: row.login,
        userAgent: row.user_agent,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
    };
}

/** {@link WebSessionStore} on the bus-state postgres (`web_login_tokens`, `web_sessions`). */
export class PostgresWebSessionStore implements WebSessionStore {
    private readonly connect: () => Promise<PostgresConnection>;

    /**
     * @param connect Returns the (shared) connection; called per operation
     *   so the store can be built before postgres is up.
     */
    constructor(connect: () => Promise<PostgresConnection>) {
        this.connect = connect;
    }

    async createLoginToken(login: string, ttlMs: number): Promise<string> {
        const token = generateToken();
        const pool = (await this.connect()).getPool();
        // Opportunistic cleanup keeps the table tiny without a sweeper.
        await pool.query("DELETE FROM web_login_tokens WHERE expires_at <= now()");
        await pool.query(
            `INSERT INTO web_login_tokens (token_hash, login, expires_at)
             VALUES ($1, $2, now() + make_interval(secs => $3))`,
            [hashToken(token), login, ttlMs / 1000],
        );
        return token;
    }

    async redeemLoginToken(token: string): Promise<string | null> {
        const pool = (await this.connect()).getPool();
        const result = await pool.query<{ login: string }>(
            `DELETE FROM web_login_tokens
             WHERE token_hash = $1 AND expires_at > now()
             RETURNING login`,
            [hashToken(token)],
        );
        return result.rows[0]?.login ?? null;
    }

    async createSession(login: string, userAgent: string | null, ttlMs: number): Promise<string> {
        const token = generateToken();
        const pool = (await this.connect()).getPool();
        await pool.query("DELETE FROM web_sessions WHERE expires_at <= now()");
        await pool.query(
            `INSERT INTO web_sessions (token_hash, login, user_agent, expires_at)
             VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
            [hashToken(token), login, userAgent, ttlMs / 1000],
        );
        return token;
    }

    async findSession(token: string): Promise<WebSession | null> {
        const pool = (await this.connect()).getPool();
        const result = await pool.query<RawSessionRow>(
            `UPDATE web_sessions SET last_seen_at = now()
             WHERE token_hash = $1 AND expires_at > now()
             RETURNING id, login, user_agent, created_at, last_seen_at, expires_at`,
            [hashToken(token)],
        );
        const row = result.rows[0];
        return row === undefined ? null : toSession(row);
    }

    async deleteSessionByToken(token: string): Promise<void> {
        const pool = (await this.connect()).getPool();
        await pool.query("DELETE FROM web_sessions WHERE token_hash = $1", [hashToken(token)]);
    }

    async listSessions(): Promise<readonly WebSession[]> {
        const pool = (await this.connect()).getPool();
        const result = await pool.query<RawSessionRow>(
            `SELECT id, login, user_agent, created_at, last_seen_at, expires_at
             FROM web_sessions WHERE expires_at > now()
             ORDER BY created_at DESC`,
        );
        return result.rows.map(toSession);
    }

    async revokeSessions(target: string): Promise<number> {
        const pool = (await this.connect()).getPool();
        if (target === "all") {
            const result = await pool.query("DELETE FROM web_sessions");
            return result.rowCount ?? 0;
        }
        const result = await pool.query("DELETE FROM web_sessions WHERE id::text = $1", [target]);
        return result.rowCount ?? 0;
    }
}
