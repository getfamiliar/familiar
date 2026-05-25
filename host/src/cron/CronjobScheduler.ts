import { readFileSync } from "node:fs";
import {
    EVENT_PRIORITY,
    type Logger,
    type NewEvent,
    type ParsedCron,
    parseCron,
    type WorkspaceFile,
} from "@getfamiliar/shared";
import { Cron } from "croner";
import type { WorkspaceWatcher } from "../workspace/WorkspaceWatcher.js";

/** A single scheduled cron entry — the parsed expression plus its live job. */
interface ScheduledEntry {
    readonly parsed: ParsedCron;
    readonly job: Cron;
}

/** Snapshot row returned by {@link CronjobScheduler.list}. */
export interface ScheduledRow {
    readonly relativePath: string;
    readonly verbatim: string;
    readonly expression: string;
    readonly source: "friendly" | "raw";
}

/** Filter used to recognise cron-bearing handler files. */
const CRON_FILTER = { frontmatter: { cron: "*" } } as const;

/**
 * Schedules a Croner job for every handler `.md` whose frontmatter
 * declares a `cron:` field. Owned by the host daemon; talks to the
 * workspace watcher for discovery and a caller-supplied `emit`
 * closure for event emission.
 *
 * Invalid expressions (neither friendly-node-cron nor Croner accept
 * them) are logged at `warn` and dropped — the rest of the workspace
 * keeps working. Handler files at the workspace root are also dropped
 * with a warning: handlers must live under at least one topic folder
 * so the path → topic mapping is unambiguous.
 */
export class CronjobScheduler {
    private readonly watcher: WorkspaceWatcher;
    private readonly emit: (event: NewEvent) => Promise<{ id: string }>;
    private readonly log: Logger;
    private readonly jobs = new Map<string, ScheduledEntry>();
    private unsubscribe: (() => void) | undefined;

    constructor(opts: {
        watcher: WorkspaceWatcher;
        emit: (event: NewEvent) => Promise<{ id: string }>;
        log: Logger;
    }) {
        this.watcher = opts.watcher;
        this.emit = opts.emit;
        this.log = opts.log;
    }

    /** Initial scan + subscribe for live updates. Call once at daemon start. */
    async start(): Promise<void> {
        const files = await this.watcher.listMarkdownFiles(CRON_FILTER);
        for (const file of files) {
            this.register(file);
        }
        this.unsubscribe = this.watcher.onMarkdownFileUpdate(CRON_FILTER, (file) =>
            this.onUpdate(file),
        );
        this.log.info({ count: this.jobs.size }, "cronjob scheduler ready");
    }

    /** Stop every scheduled job and detach from the watcher. Idempotent. */
    async stop(): Promise<void> {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = undefined;
        }
        for (const entry of this.jobs.values()) {
            entry.job.stop();
        }
        this.jobs.clear();
    }

    /** Snapshot of currently-scheduled jobs. Used for diagnostics. */
    list(): readonly ScheduledRow[] {
        const out: ScheduledRow[] = [];
        for (const [relativePath, entry] of this.jobs) {
            out.push({
                relativePath,
                verbatim: entry.parsed.verbatim,
                expression: entry.parsed.expression,
                source: entry.parsed.source,
            });
        }
        return out;
    }

    private onUpdate(file: WorkspaceFile): void {
        if (file.kind === "removed") {
            this.unregister(file.relativePath);
            return;
        }
        this.unregister(file.relativePath);
        this.register(file);
    }

    /** Parse the file's cron and install a job. No-op on invalid input. */
    private register(file: WorkspaceFile): void {
        const verbatim = readVerbatimCron(file.absolutePath);
        if (verbatim === undefined) {
            // Filter matched a moment ago but the file has changed
            // again; nothing to do.
            return;
        }
        const target = pathToHandlerTarget(file.relativePath);
        if (target === null) {
            this.log.warn(
                { path: file.relativePath },
                "cron found on file at workspace root, skipping (handlers must live under a topic folder)",
            );
            return;
        }
        const parsed = parseCron(verbatim);
        if (parsed === null) {
            this.log.warn(
                { path: file.relativePath, verbatim },
                "cronjob expression invalid, dropping",
            );
            return;
        }
        const job = new Cron(parsed.expression, () => {
            void this.fire(file.relativePath, parsed.verbatim, target);
        });
        this.jobs.set(file.relativePath, { parsed, job });
        this.log.info(`cronjob for handler ${file.relativePath} scheduled at ${parsed.verbatim}`);
    }

    private unregister(relativePath: string): void {
        const existing = this.jobs.get(relativePath);
        if (!existing) {
            return;
        }
        existing.job.stop();
        this.jobs.delete(relativePath);
        this.log.info(`cronjob for handler ${relativePath} removed`);
    }

    private async fire(
        relativePath: string,
        verbatim: string,
        target: { topic: string; startHandler: string },
    ): Promise<void> {
        const event: NewEvent = {
            topic: target.topic,
            startHandler: target.startHandler,
            prompt: "The cronjob has fired",
            priority: EVENT_PRIORITY.BACKGROUND,
            privileged: false,
        };
        try {
            const handle = await this.emit(event);
            this.log.info(
                `cronjob for handler ${relativePath} (${verbatim}) triggered - created event #${handle.id}`,
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.error({ path: relativePath, err: message }, "cronjob fired but emit failed");
        }
    }
}

/**
 * Map a workspace-relative handler path to its `(topic, startHandler)`
 * pair. Returns `null` for files at the workspace root, which are not
 * handlers by project convention (root holds SOUL.md, CONTEXT.md, etc.).
 *
 * Example: `mail/important/digest.md` → `mail:important` / `digest`.
 */
export function pathToHandlerTarget(
    relativePath: string,
): { topic: string; startHandler: string } | null {
    const parts = relativePath.split("/");
    if (parts.length < 2) {
        return null;
    }
    const file = parts[parts.length - 1];
    const startHandler = file.endsWith(".md") ? file.slice(0, -3) : file;
    const topic = parts.slice(0, -1).join(":");
    return { topic, startHandler };
}

/**
 * Read just the `cron:` field from a file's YAML frontmatter without
 * pulling in the full handler parser. Returns `undefined` if there is
 * no frontmatter, no `cron:` key, or the file cannot be read.
 *
 * Exported so the `cli.sh cron list` CLI uses the same extraction path.
 */
export function readVerbatimCron(absolutePath: string): string | undefined {
    let source: string;
    try {
        source = readFileSync(absolutePath, "utf8");
    } catch {
        return undefined;
    }
    const trimmed = source.trimStart();
    const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n?/);
    if (!match) {
        return undefined;
    }
    const cron = match[1].match(/^cron\s*:\s*(.+?)\s*$/m);
    if (!cron) {
        return undefined;
    }
    return stripQuotes(cron[1]);
}

function stripQuotes(value: string): string {
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return value.slice(1, -1);
        }
    }
    return value;
}
