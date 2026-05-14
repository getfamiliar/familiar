import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * In-memory + on-disk store of the highest `receivedDateTime` already
 * processed per (provider, account, mailbox). Persisted as JSON under
 * `<dataDir>/mail/watermarks.json`. Atomic writes via tmp-file +
 * rename so a crashed write doesn't leave a corrupt file.
 *
 * Storage shape (ISO-8601 timestamps):
 *
 * ```json
 * {
 *   "o365": {
 *     "user@org.com": {
 *       "user@org.com":        "2026-05-14T12:30:00Z",
 *       "shared@org.com":      "2026-05-14T11:00:00Z"
 *     }
 *   }
 * }
 * ```
 *
 * Account is part of the path because shared mailboxes are reachable
 * through any account with delegated access — keeping them
 * account-scoped prevents two accounts from racing on the same
 * mailbox.
 */
export class WatermarkStore {
    private readonly filePath: string;
    private state: Record<string, Record<string, Record<string, string>>> = {};
    private loaded = false;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    /**
     * Read the JSON file on first use. Missing file is fine — the
     * store starts empty. Malformed JSON is logged-and-discarded so a
     * hand-edit gone wrong doesn't block polling permanently; the
     * next successful poll rewrites it cleanly.
     */
    async load(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        if (!existsSync(this.filePath)) {
            return;
        }
        try {
            const raw = await readFile(this.filePath, "utf-8");
            const parsed = JSON.parse(raw) as unknown;
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                this.state = parsed as typeof this.state;
            }
        } catch {
            // Treat as empty; next write will overwrite the bad file.
            this.state = {};
        }
    }

    /** Lookup a watermark. Returns `null` if this mailbox is unseen. */
    get(providerId: string, account: string, mailbox: string): string | null {
        return this.state[providerId]?.[account]?.[mailbox] ?? null;
    }

    /**
     * Set the watermark and flush atomically to disk. Each call
     * rewrites the whole file — the volume is tiny (≤ a few hundred
     * tiny strings) so partial writes aren't worth the complexity.
     */
    async set(providerId: string, account: string, mailbox: string, value: string): Promise<void> {
        const provider = this.state[providerId] ?? {};
        const acct = provider[account] ?? {};
        acct[mailbox] = value;
        provider[account] = acct;
        this.state[providerId] = provider;
        await this.flush();
    }

    /** Atomic write: tmp file + rename so a crash never leaves a half-written file. */
    private async flush(): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf-8");
        await rename(tmp, this.filePath);
    }
}
