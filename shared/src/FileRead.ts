/** Insert shape of a `file_reads` row — `id` and `readAt` are filled by the DB. */
export interface NewFileRead {
    /** Workspace-relative path of the file read, e.g. `wiki/people/anna.md`. */
    readonly path: string;
    readonly agentRunId?: string | null;
    readonly eventId?: string | null;
    /** Workspace-relative path of the handler whose run read the file. */
    readonly handlerPath: string;
}

/** What {@link import("./FileReadBus.js").FileReadBus.summarize} filters on. */
export interface FileReadSummaryOptions {
    /** Only files whose path starts with this, e.g. `wiki/`. */
    readonly pathPrefix: string;
    /** Only reads at or after this instant. */
    readonly since: Date;
    /** Reads by runs of handlers under these paths don't count, e.g. `skills/memory/`. */
    readonly excludeHandlerPrefixes?: readonly string[];
}

/** How often one file was read, as {@link import("./FileReadBus.js").FileReadBus.summarize} reports it. */
export interface FileReadSummary {
    /** Workspace-relative path. */
    readonly path: string;
    /** Distinct agent runs that read the file (several chunks of one run count once). */
    readonly readingRuns: number;
    /** The latest read. */
    readonly lastReadAt: Date;
}
