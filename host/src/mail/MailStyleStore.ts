import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
    MAIL_STYLE_TEMPLATE_DEFAULTS,
    type MailStyleTemplate,
    mailStyleTemplatePath,
} from "@getfamiliar/shared";

/**
 * One cached entry per `(mailbox, name)` key. `null` `mtimeMs` is the
 * sentinel for "file didn't exist at last check" — distinguished from
 * "file exists with mtime=0" so a freshly-written template lands on
 * the next read.
 */
interface CacheEntry {
    readonly mtimeMs: number | null;
    /** `undefined` when the file is absent or malformed at last check. */
    readonly template: MailStyleTemplate | undefined;
}

/** One enumeration entry returned by {@link MailStyleStore.list}. */
export interface MailStyleListing {
    readonly mailbox: string;
    readonly name: string;
}

/**
 * In-memory cache + atomic-write surface for per-mailbox style
 * templates under `<dataDir>/mail/templates/<mailbox>/<name>.json`.
 *
 * - Reads are mtime-cached: each `get` re-stats the file, and the
 *   parsed body is only re-read when the mtime changed since the
 *   cached snapshot. Means a hand-edit of the JSON file lands on the
 *   next outgoing send with no daemon restart, and the read path
 *   stays bounded to a single `stat` (+ at most one `readFile` + parse)
 *   per call.
 * - Writes go through `update`, which applies partial-update semantics:
 *   existing files get a load → merge → atomic-rewrite cycle; absent
 *   files get the defaults from {@link MAIL_STYLE_TEMPLATE_DEFAULTS}
 *   for any field the caller omitted.
 * - Enumeration via `list` walks `<dataDir>/mail/templates/*` and
 *   returns only `{mailbox, name}` tuples — the agent picks one and
 *   calls `get` to pull the body.
 *
 * Stateless across daemon restarts; the cache lives only in memory.
 */
export class MailStyleStore {
    private readonly dataDir: string;
    private readonly entries = new Map<string, CacheEntry>();
    private readonly logMalformed: (message: string) => void;

    /**
     * @param dataDir Absolute data root (matches the host's `ctx.dataDir`).
     * @param logMalformed Optional sink for malformed-JSON warnings.
     *   Defaults to `console.warn` so unit tests and standalone use
     *   still surface the problem; the daemon wires `log.warn` here.
     */
    constructor(dataDir: string, logMalformed: (message: string) => void = console.warn) {
        this.dataDir = dataDir;
        this.logMalformed = logMalformed;
    }

    /**
     * Return the cached `MailStyleTemplate` for `(mailbox, name)`, or
     * `undefined` when no template file exists yet, the file is
     * unreadable, or its JSON is malformed. Re-checks the file's
     * `mtimeMs` on every call; body is re-read only when the mtime
     * changed.
     */
    async get(mailbox: string, name: string = "default"): Promise<MailStyleTemplate | undefined> {
        const file = mailStyleTemplatePath(this.dataDir, mailbox, name);
        const key = `${mailbox}\x00${name}`;
        let currentMtime: number | null;
        try {
            const s = await stat(file);
            currentMtime = s.mtimeMs;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
                this.entries.set(key, { mtimeMs: null, template: undefined });
                return undefined;
            }
            throw err;
        }
        const cached = this.entries.get(key);
        if (cached && cached.mtimeMs === currentMtime) {
            return cached.template;
        }
        const raw = await readFile(file, "utf8");
        let template: MailStyleTemplate | undefined;
        try {
            template = parseTemplate(raw);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.logMalformed(
                `mail style template at ${file} could not be parsed (${reason}); falling back to no-template behaviour until the next refresh`,
            );
            template = undefined;
        }
        this.entries.set(key, { mtimeMs: currentMtime, template });
        return template;
    }

    /**
     * Partial-update write. Loads the existing template (if any),
     * overlays the supplied non-undefined fields, atomically rewrites
     * the file. For a brand-new file, defaults from
     * {@link MAIL_STYLE_TEMPLATE_DEFAULTS} fill in any field the caller
     * omitted. Cache invalidates implicitly via the file's new mtime.
     */
    async update(
        mailbox: string,
        name: string,
        patch: Partial<MailStyleTemplate>,
    ): Promise<MailStyleTemplate> {
        const existing = await this.readRaw(mailbox, name);
        const base: MailStyleTemplate = existing ?? MAIL_STYLE_TEMPLATE_DEFAULTS;
        const merged: MailStyleTemplate = {
            signature: patch.signature ?? base.signature,
            textStyle: patch.textStyle ?? base.textStyle,
            usePlainText: patch.usePlainText ?? base.usePlainText,
            useSignatureOnReplies: patch.useSignatureOnReplies ?? base.useSignatureOnReplies,
            useSignatureOnForwards: patch.useSignatureOnForwards ?? base.useSignatureOnForwards,
        };
        const file = mailStyleTemplatePath(this.dataDir, mailbox, name);
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
        await rename(tmp, file);
        return merged;
    }

    /**
     * Enumerate every `(mailbox, name)` pair that has a JSON file on
     * disk under `<dataDir>/mail/templates/`. Cheap walk — only the
     * directory and filename are read; the file contents are not
     * touched. Returns an empty array when the templates root doesn't
     * exist yet.
     */
    async list(): Promise<readonly MailStyleListing[]> {
        const root = path.join(this.dataDir, "mail", "templates");
        if (!existsSync(root)) {
            return [];
        }
        const out: MailStyleListing[] = [];
        let mailboxDirs: import("node:fs").Dirent[];
        try {
            mailboxDirs = await readdir(root, { withFileTypes: true });
        } catch {
            return [];
        }
        for (const dirent of mailboxDirs) {
            if (!dirent.isDirectory()) {
                continue;
            }
            const mailbox = dirent.name;
            const mailboxDir = path.join(root, mailbox);
            let files: import("node:fs").Dirent[];
            try {
                files = await readdir(mailboxDir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const file of files) {
                if (!file.isFile() || !file.name.endsWith(".json")) {
                    continue;
                }
                const name = file.name.slice(0, -".json".length);
                out.push({ mailbox, name });
            }
        }
        out.sort((a, b) =>
            a.mailbox === b.mailbox
                ? a.name.localeCompare(b.name)
                : a.mailbox.localeCompare(b.mailbox),
        );
        return out;
    }

    /**
     * Bypass the cache and read the file fresh. Used by {@link update}
     * so a write builds on the latest on-disk state even if the cache
     * is stale.
     */
    private async readRaw(mailbox: string, name: string): Promise<MailStyleTemplate | undefined> {
        const file = mailStyleTemplatePath(this.dataDir, mailbox, name);
        let raw: string;
        try {
            raw = await readFile(file, "utf8");
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
                return undefined;
            }
            throw err;
        }
        try {
            return parseTemplate(raw);
        } catch {
            return undefined;
        }
    }
}

/**
 * Parse + minimally validate a template file. Throws when the JSON
 * doesn't shape-match the {@link MailStyleTemplate} contract. Caller
 * catches and returns `undefined`. Strict on field presence and
 * primitive types; doesn't try to validate the CSS or HTML content.
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
