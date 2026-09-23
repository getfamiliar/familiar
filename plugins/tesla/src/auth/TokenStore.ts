import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The persisted half of a Tesla login. Only tokens live here —
 * the e-mail address is kept purely so `familiar tesla status` can
 * report *whose* login this is. **Password and MFA code are never
 * written anywhere**; they exist only as locals inside the login
 * command.
 */
export interface TeslaTokens {
    /** Long-lived token used to mint fresh access tokens. */
    readonly refreshToken: string;
    /** Current bearer token for the Owner API. */
    readonly accessToken: string;
    /** Epoch milliseconds at which {@link accessToken} stops being valid. */
    readonly expiresAt: number;
    /** Account the tokens belong to; display only. */
    readonly email: string;
}

/**
 * Resolve the plugin's token file: `<dataDir>/tesla/auth.json`.
 * Centralised so the daemon, the CLI and the tests agree on the layout.
 *
 * @param dataDir Absolute path of the project's `data/` directory.
 * @returns Absolute path of the token file.
 */
export function tokenFile(dataDir: string): string {
    return path.join(dataDir, "tesla", "auth.json");
}

/**
 * Filesystem-backed store for the single Tesla login.
 *
 * Unlike ms365 (one file per mailbox) there is exactly one Tesla
 * account, so the store is one file rather than a directory registry.
 * Writes are atomic (temp + rename) at mode `0o600`, mirroring the
 * persistence contract of ms365's msal cache plugin — a crash
 * mid-write must never leave a half-parsed token file behind.
 */
export class TokenStore {
    private readonly file: string;

    constructor(file: string) {
        this.file = file;
    }

    /** Absolute path of the backing file. Used by CLI messages. */
    get filePath(): string {
        return this.file;
    }

    /**
     * Read the stored tokens.
     *
     * @returns The tokens, or `null` when no login is cached or the
     *   file is unreadable / malformed (treated as "not logged in" so a
     *   corrupted file is recoverable by re-running `tesla login`).
     */
    async read(): Promise<TeslaTokens | null> {
        let raw: string;
        try {
            raw = await fs.readFile(this.file, "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
            }
            throw err;
        }
        try {
            const parsed = JSON.parse(raw) as Partial<TeslaTokens>;
            if (
                typeof parsed.refreshToken !== "string" ||
                parsed.refreshToken.length === 0 ||
                typeof parsed.accessToken !== "string" ||
                typeof parsed.expiresAt !== "number"
            ) {
                return null;
            }
            return {
                refreshToken: parsed.refreshToken,
                accessToken: parsed.accessToken,
                expiresAt: parsed.expiresAt,
                email: typeof parsed.email === "string" ? parsed.email : "",
            };
        } catch {
            return null;
        }
    }

    /**
     * Persist tokens atomically at mode `0o600`.
     *
     * @param tokens The token set to write.
     */
    async write(tokens: TeslaTokens): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(tmp, this.file);
    }

    /**
     * Delete the token file, logging the account out.
     *
     * @returns `true` when a file was removed, `false` when none existed.
     */
    async clear(): Promise<boolean> {
        try {
            await fs.unlink(this.file);
            return true;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                return false;
            }
            throw err;
        }
    }
}
