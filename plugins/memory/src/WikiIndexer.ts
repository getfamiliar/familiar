import type { DatabaseApi, Logger, WorkspaceWatcherApi } from "@getfamiliar/shared";
import { isWikiPath, LIVE_INDEX_SCHEMA, WIKI_FOLDER, WikiIndex } from "./WikiIndex.js";

/**
 * Keeps the live wiki index in step with the workspace: a full sync at start, then one re-index
 * per watcher transition under `wiki/`.
 */
export class WikiIndexer {
    /** The live index. */
    readonly index: WikiIndex;
    private readonly workspaceDir: string;
    private readonly log: Logger;
    private unsubscribe: (() => void) | undefined;
    private initialSync: Promise<void> | undefined;

    /**
     * @param database - SQL access (`ctx.database`).
     * @param workspaceDir - Absolute workspace path.
     * @param log - Plugin logger.
     */
    constructor(database: DatabaseApi, workspaceDir: string, log: Logger) {
        this.index = new WikiIndex(database, LIVE_INDEX_SCHEMA, log);
        this.workspaceDir = workspaceDir;
        this.log = log;
    }

    /**
     * Creates the tables if needed. Throws when postgres is unreachable, so the caller can disable
     * the tools with a clear message.
     *
     * @returns Resolves once the schema exists.
     * @throws {Error} When the schema cannot be created.
     */
    async open(): Promise<void> {
        await this.index.ensureSchema();
    }

    /**
     * Subscribes to wiki file changes and starts the full sync in the background (the daemon
     * doesn't wait for it; searches see the files indexed so far).
     *
     * @param workspace - The daemon's workspace watcher.
     */
    watch(workspace: WorkspaceWatcherApi): void {
        this.unsubscribe = workspace.onMarkdownFileUpdate(
            { pathGlob: `${WIKI_FOLDER}/*` },
            (file) => {
                if (!isWikiPath(file.relativePath)) {
                    return;
                }
                const work =
                    file.kind === "removed"
                        ? this.index.removeFile(file.relativePath)
                        : this.index.indexFile(this.workspaceDir, file.relativePath);
                work.catch((err: unknown) => {
                    this.log.warn(
                        `memory: indexing ${file.relativePath} failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                });
            },
        );
        const startedAt = Date.now();
        this.initialSync = this.index
            .syncAll(this.workspaceDir)
            .then((summary) => {
                this.log.info(
                    `memory: wiki index in sync — ${summary.written} file(s) written, ${summary.unchanged} unchanged, ${summary.removed} removed in ${Date.now() - startedAt} ms`,
                );
            })
            .catch((err: unknown) => {
                this.log.error(
                    `memory: initial wiki sync failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            });
    }

    /**
     * Stops watching and waits for the initial sync to settle.
     *
     * @returns Resolves once idle.
     */
    async close(): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        await this.initialSync;
    }
}
