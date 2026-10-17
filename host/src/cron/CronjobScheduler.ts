import { existsSync, readFileSync } from "node:fs";
import {
    EVENT_PRIORITY,
    type Logger,
    matchesAnyGlob,
    type NewEvent,
    type ParsedCron,
    parseCron,
    topicFromHandlerPath,
    twinHandlerPath,
    type WorkspaceFile,
} from "@getfamiliar/shared";
import { Cron } from "croner";
import type { WorkspaceWatcher } from "../utils/WorkspaceWatcher.js";

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
 *
 * A firing emits an exact-topic event: the topic derived from the file
 * (`mail/digest.md` → `mail:digest`) must resolve to that very file, it
 * never falls back up the topic chain. A folder-form `x/index.md` whose
 * file-form twin `x.md` exists is shadowed — the event would run `x.md`
 * — so its firing is skipped with a warning (checked at fire time, as
 * the twin can appear or vanish after registration).
 */
export class CronjobScheduler {
    private readonly watcher: WorkspaceWatcher;
    private readonly emit: (event: NewEvent) => Promise<{ id: string }>;
    private readonly log: Logger;
    private readonly writablePathGlobs: readonly string[];
    private readonly jobs = new Map<string, ScheduledEntry>();
    private unsubscribe: (() => void) | undefined;

    constructor(opts: {
        watcher: WorkspaceWatcher;
        emit: (event: NewEvent) => Promise<{ id: string }>;
        log: Logger;
        /**
         * `core.writablePaths` globs (e.g. `wiki/**`). A `cron:` field
         * inside one of these paths is ignored — those files are writable
         * by non-privileged runs and are never handlers, so they must not
         * schedule a job. Mirrors the container's `HandlerFile.load` guard.
         */
        writablePathGlobs?: readonly string[];
    }) {
        this.watcher = opts.watcher;
        this.emit = opts.emit;
        this.log = opts.log;
        this.writablePathGlobs = opts.writablePathGlobs ?? [];
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
        if (matchesAnyGlob(this.writablePathGlobs, file.relativePath)) {
            this.log.warn(
                { path: file.relativePath },
                `cron found on file ${file.relativePath} under core.writablePaths, skipping (writable files are never handlers)`,
            );
            return;
        }
        const topic = topicFromHandlerPath(file.relativePath);
        if (topic === null) {
            this.log.warn(
                { path: file.relativePath },
                `cron found on file ${file.relativePath}, skipping (handlers must live under a topic folder and their path must form a valid topic)`,
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
            void this.fire(file, parsed.verbatim, topic);
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

    /**
     * Emit the exact-topic event for one cron firing, unless the file is
     * shadowed by its file-form twin.
     *
     * @param file The cron-bearing handler file.
     * @param verbatim The `cron:` value, for logging.
     * @param topic The topic derived from the file's path.
     */
    private async fire(file: WorkspaceFile, verbatim: string, topic: string): Promise<void> {
        const relativePath = file.relativePath;
        const twin = twinHandlerPath(relativePath);
        if (relativePath.endsWith("/index.md") && twin !== null) {
            const workspaceDir = file.absolutePath.slice(
                0,
                file.absolutePath.length - relativePath.length,
            );
            if (existsSync(`${workspaceDir}${twin}`)) {
                this.log.warn(
                    { path: relativePath, twin },
                    `cronjob for handler ${relativePath} (${verbatim}) skipped: ${twin} also exists and takes precedence for topic ${topic}; delete one of them`,
                );
                return;
            }
        }
        const event: NewEvent = {
            topic,
            isExactTopic: true,
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
            this.log.error(
                { path: relativePath, err: message },
                `cronjob for handler ${relativePath} fired but emit failed: ${message}`,
            );
        }
    }
}

/**
 * Read just the `cron:` field from a file's YAML frontmatter without
 * pulling in the full handler parser. Returns `undefined` if there is
 * no frontmatter, no `cron:` key, or the file cannot be read.
 *
 * Exported so the `familiar events list-crons` CLI uses the same extraction path.
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
