import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Schema version of the JSON file on disk. Bumped whenever the id
 * type or shape encoded in the delta link changes — Graph rejects
 * mixed id types across pages of a single delta walk, so a saved
 * cursor from a previous id-type configuration is unusable. On
 * version mismatch the store loads as empty and the next poll
 * restarts from "now" against the new id type.
 *
 * Version history:
 *   1  — initial release (default Graph id type)
 *   2  — switched to `Prefer: IdType="ImmutableId"` on every request,
 *        so old cursors are incompatible
 */
const SCHEMA_VERSION = 2;

interface CursorFileShape {
    readonly version: number;
    readonly cursors: Record<string, Record<string, string>>;
}

/**
 * On-disk store of the latest `@odata.deltaLink` per (upn, mailbox).
 * Persisted as JSON at `data/ms365/mail/delta.json`. Atomic writes
 * via tmp file + rename so a crashed write never leaves a partial
 * file.
 *
 * Storage shape (one nested object per UPN; keys are mailbox
 * addresses):
 *
 * ```json
 * {
 *   "version": 2,
 *   "cursors": {
 *     "user@org.com": {
 *       "user@org.com": "https://graph.microsoft.com/.../delta?$deltatoken=…",
 *       "shared@org.com": "…"
 *     }
 *   }
 * }
 * ```
 *
 * On a fresh entry (`get` returns `null`), the poll loop starts a new
 * delta walk against `/users/{mailbox}/mailFolders/inbox/messages/delta`
 * with no `$deltatoken` — Graph's documented "start from now" behavior.
 * Because of that, dropping a cursor is the safe answer to a 410 Gone
 * or any other delta-link rot: the next poll restarts from now and the
 * bus's idempotency-key dedup prevents duplicate events on re-walk.
 */
export class DeltaCursorStore {
    private readonly filePath: string;
    private state: Record<string, Record<string, string>> = {};
    private loaded = false;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    /**
     * Read the JSON file on first use. Missing file is fine — the
     * store starts empty. Malformed JSON, missing version field, or
     * version mismatch are all treated as "empty" so the next
     * successful poll rewrites it cleanly — protects against
     * hand-edits and against the schema-version bump used to
     * invalidate id-type-incompatible cursors.
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
            if (!isCursorFile(parsed)) {
                return;
            }
            if (parsed.version !== SCHEMA_VERSION) {
                return;
            }
            this.state = { ...parsed.cursors };
        } catch {
            this.state = {};
        }
    }

    /**
     * Lookup the saved delta link for this `(upn, mailbox)` pair, or
     * `null` for a fresh mailbox. `null` tells the poll loop to start
     * a new delta walk via {@link GraphClient.listInboxDelta} with no
     * cursor — Graph then begins at "now" and returns the new
     * `@odata.deltaLink` in the final page of the walk.
     */
    get(upn: string, mailbox: string): string | null {
        return this.state[upn]?.[mailbox] ?? null;
    }

    /**
     * Set the cursor and flush atomically to disk. Each call rewrites
     * the whole file — the volume is tiny (≤ a few hundred short
     * URLs) so partial writes aren't worth the complexity.
     */
    async set(upn: string, mailbox: string, deltaLink: string): Promise<void> {
        const forUpn = this.state[upn] ?? {};
        forUpn[mailbox] = deltaLink;
        this.state[upn] = forUpn;
        await this.flush();
    }

    /**
     * Drop the cursor for a mailbox (e.g. after a 410 Gone). The next
     * `get` returns `null` and the poll loop restarts from now.
     */
    async drop(upn: string, mailbox: string): Promise<void> {
        const forUpn = this.state[upn];
        if (!forUpn) {
            return;
        }
        if (!(mailbox in forUpn)) {
            return;
        }
        delete forUpn[mailbox];
        if (Object.keys(forUpn).length === 0) {
            delete this.state[upn];
        }
        await this.flush();
    }

    private async flush(): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        const fileBody: CursorFileShape = {
            version: SCHEMA_VERSION,
            cursors: this.state,
        };
        await writeFile(tmp, JSON.stringify(fileBody, null, 2), "utf-8");
        await rename(tmp, this.filePath);
    }
}

function isCursorFile(value: unknown): value is CursorFileShape {
    if (value === null || typeof value !== "object") {
        return false;
    }
    const candidate = value as { version?: unknown; cursors?: unknown };
    if (typeof candidate.version !== "number") {
        return false;
    }
    if (candidate.cursors === null || typeof candidate.cursors !== "object") {
        return false;
    }
    return true;
}
