import { readFile, stat } from "node:fs/promises";
import { type MailStyleTemplate, mailStyleTemplatePath } from "./MailStyleTemplate.js";

/**
 * One cached entry per mailbox. `null` `mtimeMs` is the sentinel for
 * "file didn't exist at last check" — distinguished from "file exists
 * with mtime=0" so a freshly-extracted template lands on the next
 * send.
 */
interface CacheEntry {
    readonly mtimeMs: number | null;
    /** `null` when the file is absent or malformed. */
    readonly template: MailStyleTemplate | null;
}

/**
 * In-memory cache of per-mailbox style templates. Each `get` re-stats
 * the file: when `mtimeMs` is unchanged the previous parse is reused;
 * otherwise the file is re-read and re-parsed. Means a hand-edit of
 * the JSON file lands on the next outgoing send with no daemon
 * restart, and the read path stays bounded to a single `stat` + at
 * most one `readFile` + parse per call.
 *
 * Stateless across daemon restarts — the cache lives only in memory.
 * Persistence is owned by {@link TemplateExtractor}.
 */
export class TemplateCache {
    private readonly dataDir: string;
    private readonly entries = new Map<string, CacheEntry>();
    private readonly logMalformed: (message: string) => void;

    /**
     * @param dataDir Absolute data root (matches `ctx.dataDir`).
     * @param logMalformed Optional sink for malformed-JSON warnings
     *   (defaults to `console.warn` so smoke tests / standalone use
     *   still surface the problem). The daemon wires `ctx.log` here.
     */
    constructor(dataDir: string, logMalformed: (message: string) => void = console.warn) {
        this.dataDir = dataDir;
        this.logMalformed = logMalformed;
    }

    /**
     * Return the cached `MailStyleTemplate` for `mailbox`, or `null`
     * when no template file exists yet, the file is unreadable, or
     * its JSON is malformed. Re-checks the file's `mtimeMs` on every
     * call; the file body is only re-read when the mtime changed.
     */
    async get(mailbox: string): Promise<MailStyleTemplate | null> {
        const file = mailStyleTemplatePath(this.dataDir, mailbox);
        let currentMtime: number | null;
        try {
            const s = await stat(file);
            currentMtime = s.mtimeMs;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
                this.entries.set(mailbox, { mtimeMs: null, template: null });
                return null;
            }
            throw err;
        }
        const cached = this.entries.get(mailbox);
        if (cached && cached.mtimeMs === currentMtime) {
            return cached.template;
        }
        const raw = await readFile(file, "utf8");
        let template: MailStyleTemplate | null;
        try {
            template = parseTemplate(raw);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.logMalformed(
                `ms365 template-cache: ${file} could not be parsed (${reason}); falling back to no-template behaviour until the next refresh`,
            );
            template = null;
        }
        this.entries.set(mailbox, { mtimeMs: currentMtime, template });
        return template;
    }
}

/**
 * Parse + minimally validate a template file. Throws when the JSON
 * doesn't shape-match the {@link MailStyleTemplate} contract — caller
 * catches and returns `null` so a hand-edit typo doesn't crash the
 * send path. Strict on field presence and primitive types; doesn't
 * try to validate the CSS or HTML content itself.
 */
function parseTemplate(raw: string): MailStyleTemplate {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const signature = parsed.signature;
    const textStyle = parsed.textStyle;
    const usePlainText = parsed.usePlainText;
    const useSignatureOnReplies = parsed.useSignatureOnReplies;
    const useSignatureOnForwards = parsed.useSignatureOnForwards;
    if (typeof signature !== "string") {
        throw new Error("missing or non-string `signature`");
    }
    if (typeof textStyle !== "string") {
        throw new Error("missing or non-string `textStyle`");
    }
    if (typeof usePlainText !== "boolean") {
        throw new Error("missing or non-boolean `usePlainText`");
    }
    if (typeof useSignatureOnReplies !== "boolean") {
        throw new Error("missing or non-boolean `useSignatureOnReplies`");
    }
    if (typeof useSignatureOnForwards !== "boolean") {
        throw new Error("missing or non-boolean `useSignatureOnForwards`");
    }
    return { signature, textStyle, usePlainText, useSignatureOnReplies, useSignatureOnForwards };
}
