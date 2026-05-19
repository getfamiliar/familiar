import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Schema version of the JSON cursor file. Bumped whenever the encoded
 * Graph delta link shape changes — e.g. a change to the projection
 * we request in `$select` doesn't strictly invalidate the cursor, but
 * a flip in the window-format definitely does. On version mismatch
 * the store loads as empty and the next poll restarts the delta
 * walk from the configured window.
 *
 * Version history:
 *   1  — initial release.
 */
const SCHEMA_VERSION = 1;

interface CursorFileShape {
    readonly version: number;
    /** `upn → calendarId → deltaLink` */
    readonly cursors: Record<string, Record<string, string>>;
}

/**
 * On-disk store of the latest `@odata.deltaLink` per `(upn, calendarId)`.
 * Mirrors the mail-side {@link import("../mail/DeltaCursorStore.js").DeltaCursorStore}
 * structurally: JSON file with atomic tmp+rename writes; schema
 * version guard drops the file on mismatch.
 *
 * Lives at `data/ms365/calendar/delta.json`. Bind-mounted only on
 * the host; the agent container never touches this file.
 */
export class CalendarCursorStore {
    private readonly filePath: string;
    private state: Record<string, Record<string, string>> = {};
    private loaded = false;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

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

    get(upn: string, calendarId: string): string | null {
        return this.state[upn]?.[calendarId] ?? null;
    }

    async set(upn: string, calendarId: string, deltaLink: string): Promise<void> {
        const forUpn = this.state[upn] ?? {};
        forUpn[calendarId] = deltaLink;
        this.state[upn] = forUpn;
        await this.flush();
    }

    async drop(upn: string, calendarId: string): Promise<void> {
        const forUpn = this.state[upn];
        if (!forUpn) {
            return;
        }
        if (!(calendarId in forUpn)) {
            return;
        }
        delete forUpn[calendarId];
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
