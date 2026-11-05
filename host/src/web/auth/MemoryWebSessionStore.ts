import { generateToken, type WebSession, type WebSessionStore } from "./WebSessionStore.js";

/**
 * In-memory {@link WebSessionStore} for tests; expiry is checked against
 * the wall clock. Not used in production code.
 */
export class MemoryWebSessionStore implements WebSessionStore {
    readonly loginTokens = new Map<string, { login: string; expiresAt: number }>();
    readonly sessions = new Map<string, WebSession>();

    async createLoginToken(login: string, ttlMs: number): Promise<string> {
        const token = generateToken();
        this.loginTokens.set(token, { login, expiresAt: Date.now() + ttlMs });
        return token;
    }

    async redeemLoginToken(token: string): Promise<string | null> {
        const entry = this.loginTokens.get(token);
        this.loginTokens.delete(token);
        return entry !== undefined && entry.expiresAt > Date.now() ? entry.login : null;
    }

    async createSession(login: string, userAgent: string | null, ttlMs: number): Promise<string> {
        const token = generateToken();
        const now = new Date();
        this.sessions.set(token, {
            id: `id-${this.sessions.size}`,
            login,
            userAgent,
            createdAt: now,
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + ttlMs),
        });
        return token;
    }

    async findSession(token: string): Promise<WebSession | null> {
        const session = this.sessions.get(token);
        return session !== undefined && session.expiresAt.getTime() > Date.now() ? session : null;
    }

    async deleteSessionByToken(token: string): Promise<void> {
        this.sessions.delete(token);
    }

    async listSessions(): Promise<readonly WebSession[]> {
        return [...this.sessions.values()];
    }

    async revokeSessions(target: string): Promise<number> {
        let count = 0;
        for (const [token, session] of this.sessions) {
            if (target === "all" || session.id === target) {
                this.sessions.delete(token);
                count++;
            }
        }
        return count;
    }
}
