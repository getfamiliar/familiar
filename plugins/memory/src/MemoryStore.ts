import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger, WorkspaceWatcherApi } from "@getfamiliar/shared";
import { decode } from "@msgpack/msgpack";
import {
    type AnySchema,
    count,
    create,
    insert,
    load,
    type RawData,
    remove,
    search,
} from "@orama/orama";
import { persistToFile } from "@orama/plugin-data-persistence/server";
import { type EmbeddingModel, embed, embedMany } from "ai";
import type { HybridWeights } from "./Config.js";
import { indexFilePath } from "./EmbeddingsBootstrap.js";
import { type LanguagePack, resolveLanguagePack } from "./Language.js";
import { type Chunk, chunkMarkdown } from "./MarkdownChunker.js";
import { matchesAnyGlob } from "./PathGlob.js";

/** Backed-out reference plugins/CLI consume; export keeps the import shape stable. */
export type LogFn = (message: string) => void;

/**
 * One search hit as the rest of the plugin consumes it. Kept here so
 * the contextProvider, the `memory_search` tool, and the CLI smoke
 * test all speak the same shape.
 */
export interface MemoryHit {
    /** Workspace-relative path, e.g. `wiki/people/alice.md`. */
    readonly relativePath: string;
    /** Full headline trail: `# Adam Smith > ## Meetings > ### Atlanta`. */
    readonly headlines: string;
    /** Hybrid score from Orama, normalized to [0, 1]. */
    readonly score: number;
    /** Chunk body the embedding was computed from, ready to render verbatim. */
    readonly snippet: string;
    /**
     * Document-wide framing paragraph — the first plain paragraph after
     * the file's leading h1, copied verbatim onto every chunk of that
     * file (see {@link MarkdownChunker}). Empty when the file has none.
     * Used as the description for writable-path files in the injected
     * `# Memories` table.
     */
    readonly context: string;
    /**
     * Stable per-chunk content hash. Used by the context provider as
     * the suffix on the `<memory:HASH>...</memory:HASH>` open/close
     * tags so the agent can tell where each injected memory starts
     * and stops, and so each pair is unambiguously matched even if
     * multiple snippets land in the same prompt.
     */
    readonly hash: string;
}

/**
 * One stored chunk as the CLI `memory show` consumes it. Mirrors what
 * Orama persists, minus the embedding vector (irrelevant for the
 * user-facing dump).
 */
export interface StoredChunk {
    readonly id: string;
    readonly relativePath: string;
    readonly headlines: string;
    readonly context: string;
    readonly content: string;
    readonly lastModified: number;
}

/**
 * One row of the `memory list` per-file summary. `lastModifieds`
 * holds every distinct mtime seen across this file's chunks — under
 * normal operation that's exactly one value; more than one means an
 * incomplete update and the CLI surfaces the discrepancy.
 */
export interface FileSummary {
    readonly relativePath: string;
    readonly chunkCount: number;
    readonly lastModifieds: readonly number[];
}

/** Construction options for {@link MemoryStore}. */
export interface MemoryStoreOptions {
    /** Absolute path of the per-plugin data dir (`<dataDir>/memory/`). */
    readonly dataDir: string;
    /** Absolute path to the workspace root (`data/workspace/`). */
    readonly workspaceDir: string;
    /** Vercel AI SDK embedding model, already wrapped via the factory. */
    readonly embeddingModel: EmbeddingModel;
    /** Vector dimension validated by {@link handshakeEmbeddings}. */
    readonly dimension: number;
    /** Configured language name; falls back to english if unknown. */
    readonly language: string;
    /** Hybrid scoring weights for every `search()` call. */
    readonly hybridWeights: HybridWeights;
    /** Cosine-similarity floor for vector hits — see {@link MemoryConfig.minVectorSimilarity}. */
    readonly minVectorSimilarity: number;
    /** Idle seconds before the dirty index gets flushed. */
    readonly persistToDiskDelay: number;
    /** Glob patterns excluded from indexing. */
    readonly excludeGlobs: readonly string[];
    /** Pino-style logger scoped to the memory plugin. */
    readonly log: Logger;
}

/** Job recorded on the per-file queue; the worker collapses repeats. */
type JobKind = "upsert" | "remove";

const SHA_LEN = 16;

/**
 * Returns the absolute path of the memory plugin's data dir under the
 * host's `<dataDir>`. Kept here so the plugin's `index.ts` and the CLI
 * agree on the location without re-stating the literal.
 */
export function memoryDataDir(hostDataDir: string): string {
    return path.join(hostDataDir, "memory");
}

/**
 * Orama-backed memory store with hybrid search, debounced
 * file-persistence, and an async re-embed queue.
 *
 * The class is the single owner of the Orama DB instance, the queue,
 * and the persist timer. Consumers reach it via the small public
 * surface (`init`, `kickoffBackgroundSync`, `search`, `dump`,
 * `enqueue`, `close`); everything else is implementation detail.
 *
 * The class is built so the backend can be swapped under it without
 * touching `index.ts` or `ContextProvider.ts` — the public surface
 * is deliberately shaped around what those consumers need, not around
 * what Orama happens to expose.
 */
export class MemoryStore {
    private readonly opts: MemoryStoreOptions;
    private readonly language: LanguagePack;
    private readonly indexPath: string;

    // biome-ignore lint/suspicious/noExplicitAny: Orama's generated schema type is opaque post-create.
    private db: any | undefined;
    private dirty = false;
    private persistTimer: NodeJS.Timeout | undefined;

    private readonly queue = new Map<string, JobKind>();
    private inflight = false;
    private initialBatchPending = 0;
    private ready = false;
    private stopped = false;
    private wake: (() => void) | undefined;

    private unsubscribeWatcher: (() => void) | undefined;

    constructor(opts: MemoryStoreOptions) {
        this.opts = opts;
        this.language = resolveLanguagePack(opts.language, opts.log);
        this.indexPath = indexFilePath(opts.dataDir);
    }

    /**
     * Open (or create) the Orama DB. Loads from `memory.msp` when
     * present; otherwise builds a fresh in-memory DB. Does **not**
     * touch the workspace — that is {@link kickoffBackgroundSync}'s
     * job, run async so daemon boot stays fast.
     */
    async init(): Promise<void> {
        await fs.mkdir(this.opts.dataDir, { recursive: true });
        // Always create the DB with our real schema + tokenizer first.
        // The persistence plugin's `restoreFromFile` would build a
        // placeholder-schema DB and lose our stemmer/stopwords —
        // future inserts then silently fail to index because the
        // schema doesn't know about our fields. Instead: decode the
        // raw msgpack ourselves and call Orama's `load(db, raw)`,
        // which fills `db.data.*` while leaving `db.schema` and the
        // tokenizer alone.
        this.db = create({
            schema: this.schema() as AnySchema,
            components: {
                tokenizer: {
                    language: this.language.name,
                    stemmer: this.language.stemmer,
                    stopWords: [...this.language.stopwords],
                },
            },
        });
        const indexExists = await fileExists(this.indexPath);
        if (indexExists) {
            try {
                const raw = await fs.readFile(this.indexPath);
                const deserialized = decode(raw) as RawData;
                load(this.db, deserialized);
                this.opts.log.info(
                    `memory: found existing index at ${this.indexPath}, reusing it (${count(this.db)} chunks)`,
                );
                return;
            } catch (err) {
                this.opts.log.warn(
                    `memory: persisted index at ${this.indexPath} unreadable (${err instanceof Error ? err.message : String(err)}) — rebuilding from scratch`,
                );
                await fs.rm(this.indexPath, { force: true });
                // Rebuild the empty DB so the discarded state above
                // doesn't leak into the fresh index.
                this.db = create({
                    schema: this.schema() as AnySchema,
                    components: {
                        tokenizer: {
                            language: this.language.name,
                            stemmer: this.language.stemmer,
                            stopWords: [...this.language.stopwords],
                        },
                    },
                });
            }
        }
        this.opts.log.info(`memory: building fresh index at ${this.indexPath}`);
    }

    /**
     * Subscribe to workspace file transitions and seed the initial
     * scan. Fire-and-forget by design — the daemon never blocks on
     * embedding traffic. `isReady()` flips true once the initial batch
     * has drained.
     *
     * Subscription happens *before* the snapshot read so any edit
     * during the scan also lands on the queue (the Map dedups, so the
     * latest state always wins).
     */
    kickoffBackgroundSync(workspace: WorkspaceWatcherApi): void {
        this.unsubscribeWatcher = workspace.onMarkdownFileUpdate({}, (file) => {
            if (!this.isIncluded(file.relativePath)) {
                return;
            }
            if (file.kind === "removed") {
                this.enqueue(file.relativePath, "remove");
            } else {
                this.enqueue(file.relativePath, "upsert");
            }
        });

        void (async () => {
            const snapshot = await workspace.listMarkdownFiles({});
            const live = new Set<string>();
            for (const file of snapshot) {
                if (!this.isIncluded(file.relativePath)) {
                    continue;
                }
                live.add(file.relativePath);
                this.initialBatchPending++;
                this.enqueue(file.relativePath, "upsert");
            }
            // Sweep entries whose source file is gone from the workspace.
            for (const stalePath of this.indexedPaths()) {
                if (!live.has(stalePath)) {
                    this.initialBatchPending++;
                    this.enqueue(stalePath, "remove");
                }
            }
            if (this.initialBatchPending === 0) {
                this.flipReady();
            }
        })();
    }

    /** Public for the contextProvider's `if (!store.isReady())` gate. */
    isReady(): boolean {
        return this.ready;
    }

    /**
     * Hybrid search against the index. `embed(query)` is run once,
     * then handed to Orama with the configured weights. Returns hits
     * already in `MemoryHit` shape — callers don't see Orama's result
     * shape directly.
     */
    async search(
        query: string,
        opts: { readonly limit?: number; readonly signal?: AbortSignal } = {},
    ): Promise<readonly MemoryHit[]> {
        if (!this.db) {
            throw new Error("memory: search called before init");
        }
        const trimmed = query.trim();
        if (trimmed.length === 0) {
            return [];
        }
        const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 8;
        const { embedding } = await embed({
            model: this.opts.embeddingModel,
            value: trimmed,
            maxRetries: 1,
            abortSignal: opts.signal,
        });
        const results = await search(this.db, {
            mode: "hybrid",
            term: trimmed,
            vector: { value: embedding, property: "embedding" },
            // Orama's vector index defaults to a 0.8 cosine-similarity
            // floor — strict enough to drop almost every semantically
            // related (but not literal) hit before the hybrid merge.
            // We pass our own configurable floor instead.
            similarity: this.opts.minVectorSimilarity,
            includeVectors: false,
            limit,
            hybridWeights: {
                text: this.opts.hybridWeights.text,
                vector: this.opts.hybridWeights.vector,
            },
        });
        return results.hits.map((hit) => {
            const doc = hit.document as StoredDoc;
            return {
                relativePath: doc.path,
                headlines: doc.headlines,
                score: normalizeScore(hit.score),
                snippet: doc.content,
                context: doc.context,
                hash: doc.contentHash,
            };
        });
    }

    /**
     * Read just the `description:` field from a workspace file's YAML
     * frontmatter. Used by the injected `# Memories` table to describe
     * non-writable (handler) files, whose first paragraph is unhelpful
     * instruction prose. A focused single-field parse — no full YAML
     * parser pulled in; handler `description` is a single-line scalar.
     *
     * @param relativePath - Workspace-relative path of the file.
     * @returns The trimmed, unquoted description, or `undefined` when
     *   the file is unreadable, has no frontmatter, or no `description:`
     *   key.
     */
    async readFrontmatterDescription(relativePath: string): Promise<string | undefined> {
        const absolute = path.join(this.opts.workspaceDir, relativePath);
        let source: string;
        try {
            source = await fs.readFile(absolute, "utf8");
        } catch {
            return undefined;
        }
        const block = source.trimStart().match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n?/);
        if (!block) {
            return undefined;
        }
        const desc = block[1].match(/^description\s*:\s*(.+?)\s*$/m);
        if (!desc) {
            return undefined;
        }
        return stripQuotes(desc[1].trim());
    }

    /**
     * All chunks recorded for a single workspace file (for `memory
     * show`). Same docs-store walk as the internal {@link dumpRaw};
     * `search(..., { where: { path } })` cannot do exact-string match
     * on a slashed path because Orama runs the `where` value through
     * its tokenizer.
     */
    dump(relativePath: string): readonly StoredChunk[] {
        if (!this.db) {
            throw new Error("memory: dump called before init");
        }
        return this.dumpRaw(relativePath).map((doc) => ({
            id: doc.id,
            relativePath: doc.path,
            headlines: doc.headlines,
            context: doc.context,
            content: doc.content,
            lastModified: doc.lastModified,
        }));
    }

    /**
     * Per-file summary of what's indexed, sorted alphabetically by
     * path. Powers the `memory list` CLI. Every distinct
     * `lastModified` value seen for a file is preserved so the CLI
     * can flag inconsistency — under normal operation each file has
     * exactly one mtime across its chunks.
     */
    listFiles(): readonly FileSummary[] {
        if (!this.db) {
            throw new Error("memory: listFiles called before init");
        }
        const byPath = new Map<string, { count: number; mtimes: Set<number> }>();
        this.walkDocs((_id, doc) => {
            const entry = byPath.get(doc.path) ?? { count: 0, mtimes: new Set<number>() };
            entry.count += 1;
            entry.mtimes.add(doc.lastModified);
            byPath.set(doc.path, entry);
        });
        const out: FileSummary[] = [];
        for (const [relativePath, entry] of byPath) {
            out.push({
                relativePath,
                chunkCount: entry.count,
                lastModifieds: [...entry.mtimes].sort((a, b) => a - b),
            });
        }
        out.sort((a, b) =>
            a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
        );
        return out;
    }

    /**
     * Flush the dirty index, stop the worker, drop the watcher
     * subscription. Idempotent.
     */
    async close(): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        if (this.unsubscribeWatcher) {
            this.unsubscribeWatcher();
            this.unsubscribeWatcher = undefined;
        }
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        // Wake any pending wait so the worker observes `stopped` and exits.
        const wake = this.wake;
        this.wake = undefined;
        if (wake) {
            wake();
        }
        await this.persistIfDirty();
    }

    /** Queue an upsert/remove for a workspace file. Public for tests. */
    enqueue(relativePath: string, kind: JobKind): void {
        if (this.stopped) {
            return;
        }
        this.queue.set(relativePath, kind);
        if (!this.inflight) {
            void this.runWorker();
        } else if (this.wake) {
            const wake = this.wake;
            this.wake = undefined;
            wake();
        }
    }

    /**
     * Single-consumer loop draining {@link queue}. Errors per job are
     * caught and logged; the loop never throws.
     */
    private async runWorker(): Promise<void> {
        if (this.inflight) {
            return;
        }
        this.inflight = true;
        try {
            while (!this.stopped) {
                const next = takeFirst(this.queue);
                if (!next) {
                    if (this.stopped) {
                        return;
                    }
                    await new Promise<void>((resolve) => {
                        this.wake = resolve;
                    });
                    continue;
                }
                const [relativePath, kind] = next;
                const isInitialBatch = this.initialBatchPending > 0;
                try {
                    if (kind === "upsert") {
                        await this.upsertFile(relativePath);
                    } else {
                        await this.removeFile(relativePath);
                    }
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.opts.log.warn(
                        { path: relativePath, kind, err: message },
                        `memory: ${kind} "${relativePath}" failed — ${message}`,
                    );
                }
                if (isInitialBatch && this.initialBatchPending > 0) {
                    this.initialBatchPending--;
                    if (this.initialBatchPending === 0) {
                        this.flipReady();
                    }
                }
            }
        } finally {
            this.inflight = false;
        }
    }

    /** Read the file, chunk it, embed new chunks, replace this file's slice of the index. */
    private async upsertFile(relativePath: string): Promise<void> {
        if (!this.db) {
            return;
        }
        const absolute = path.join(this.opts.workspaceDir, relativePath);
        let source: string;
        let mtime: number;
        try {
            const [text, stat] = await Promise.all([
                fs.readFile(absolute, "utf8"),
                fs.stat(absolute),
            ]);
            source = text;
            mtime = stat.mtimeMs;
        } catch (err) {
            // File vanished between enqueue and read — treat as a removal.
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                await this.removeFile(relativePath);
                return;
            }
            throw err;
        }

        const chunks = chunkMarkdown(source, relativePath);
        const existing = this.dumpRaw(relativePath);

        const desiredByHash = new Map<string, Chunk>();
        for (const chunk of chunks) {
            desiredByHash.set(chunkHash(chunk), chunk);
        }
        const existingByHash = new Map<string, StoredDoc>();
        for (const doc of existing) {
            existingByHash.set(doc.contentHash, doc);
        }

        const toRemove: StoredDoc[] = [];
        const toEmbed: Chunk[] = [];
        const toTouch: StoredDoc[] = [];
        for (const [hash, doc] of existingByHash) {
            if (!desiredByHash.has(hash)) {
                toRemove.push(doc);
            } else {
                toTouch.push(doc);
            }
        }
        for (const [hash, chunk] of desiredByHash) {
            if (!existingByHash.has(hash)) {
                toEmbed.push(chunk);
            }
        }

        for (const doc of toRemove) {
            await remove(this.db, doc.id);
            this.opts.log.debug(
                { path: relativePath, headlines: doc.headlines },
                `memory: removed "${relativePath}" chunk "${doc.headlines}"`,
            );
        }

        if (toEmbed.length > 0) {
            const inputs = toEmbed.map(buildEmbeddingInput);
            const { embeddings } = await embedMany({
                model: this.opts.embeddingModel,
                values: inputs,
            });
            for (let i = 0; i < toEmbed.length; i++) {
                const chunk = toEmbed[i];
                const vector = embeddings[i];
                if (vector.length !== this.opts.dimension) {
                    throw new Error(
                        `memory: embedding dimension drift (expected ${this.opts.dimension}, got ${vector.length})`,
                    );
                }
                const hash = chunkHash(chunk);
                const id = `${relativePath}#${hash}`;
                await insert(this.db, {
                    id,
                    path: relativePath,
                    lastModified: mtime,
                    headlines: chunk.headlines,
                    context: chunk.context,
                    content: chunk.content,
                    contentHash: hash,
                    embedding: vector,
                });
                this.opts.log.debug(
                    { path: relativePath, headlines: chunk.headlines },
                    `memory: embedded "${relativePath}" chunk "${chunk.headlines}"`,
                );
            }
        }

        // Touch lastModified on unchanged chunks so the on-disk
        // `lastModified` per row matches reality even without an
        // embed cost.
        for (const doc of toTouch) {
            if (doc.lastModified !== mtime) {
                await remove(this.db, doc.id);
                await insert(this.db, {
                    ...rawToInsertable(doc),
                    lastModified: mtime,
                });
            }
        }

        const changed =
            toRemove.length > 0 ||
            toEmbed.length > 0 ||
            toTouch.some((d) => d.lastModified !== mtime);

        if (changed) {
            this.markDirty();
            this.opts.log.info(
                {
                    path: relativePath,
                    chunks: chunks.length,
                    reembedded: toEmbed.length,
                    removed: toRemove.length,
                },
                `memory: indexed "${relativePath}" — ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} total, ${toEmbed.length} re-embedded, ${toRemove.length} removed`,
            );
        }
    }

    /** Drop every chunk for this path. */
    private async removeFile(relativePath: string): Promise<void> {
        if (!this.db) {
            return;
        }
        const existing = this.dumpRaw(relativePath);
        if (existing.length === 0) {
            return;
        }
        for (const doc of existing) {
            await remove(this.db, doc.id);
        }
        this.markDirty();
        this.opts.log.info(
            { path: relativePath, chunks: existing.length },
            `memory: removed "${relativePath}" — ${existing.length} chunk${existing.length === 1 ? "" : "s"} dropped`,
        );
    }

    /**
     * All raw rows for a path, used by upsert/remove diffing and by
     * the CLI `memory show`. Reaches into Orama's documents-store
     * directly because `search(db, { where: { path } })` runs every
     * `where` value through the configured tokenizer — a slashed path
     * like `wiki/people/alice.md` never matches, and the filter
     * silently falls back to "every document", which would make every
     * file appear to displace the previous file's chunks.
     */
    private dumpRaw(relativePath: string): StoredDoc[] {
        const out: StoredDoc[] = [];
        this.walkDocs((id, doc) => {
            if (doc.path === relativePath) {
                out.push({ ...doc, id });
            }
        });
        return out;
    }

    /** Distinct workspace paths currently in the index (for snapshot reconciliation). */
    private indexedPaths(): Set<string> {
        const paths = new Set<string>();
        this.walkDocs((_id, doc) => {
            paths.add(doc.path);
        });
        return paths;
    }

    /**
     * Iterate every persisted document. The data lives at
     * `db.data.docs.docs` (the {@link DocumentsStore} is on
     * `db.documentsStore` and holds methods, not data). We funnel
     * the unavoidable internal access through this single helper so
     * the unsafe casts stay auditable. The returned id is the
     * application id (`<path>#<hash>`), not Orama's internal
     * numeric id — that's the one our `insert`/`remove` calls use.
     */
    private walkDocs(visit: (id: string, doc: StoredDoc) => void): void {
        if (!this.db) {
            return;
        }
        // biome-ignore lint/suspicious/noExplicitAny: reaches into the db handle.
        const data = (this.db as any).data;
        // biome-ignore lint/suspicious/noExplicitAny: opaque store shape.
        const docsRecord = data?.docs?.docs as Record<string, any> | undefined;
        if (!docsRecord) {
            return;
        }
        for (const doc of Object.values(docsRecord)) {
            const candidate = doc as Partial<StoredDoc> & { id?: unknown; path?: unknown };
            if (typeof candidate?.path !== "string" || typeof candidate.id !== "string") {
                continue;
            }
            visit(candidate.id, candidate as StoredDoc);
        }
    }

    private markDirty(): void {
        this.dirty = true;
        this.schedulePersist();
    }

    private schedulePersist(): void {
        if (this.stopped) {
            return;
        }
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
        }
        this.persistTimer = setTimeout(() => {
            this.persistTimer = undefined;
            void this.persistIfDirty();
        }, this.opts.persistToDiskDelay * 1000);
    }

    private async persistIfDirty(): Promise<void> {
        if (!this.dirty || !this.db) {
            return;
        }
        this.dirty = false;
        try {
            await persistToFile(this.db, "binary", this.indexPath);
            this.opts.log.info({ entries: count(this.db) }, "memory: persisted index to disk");
        } catch (err) {
            this.dirty = true;
            this.opts.log.error(
                { err: err instanceof Error ? err.message : String(err) },
                "memory: persist to disk failed",
            );
        }
    }

    private flipReady(): void {
        if (this.ready || !this.db) {
            return;
        }
        this.ready = true;
        const entries = count(this.db);
        const files = this.indexedPaths().size;
        this.opts.log.info(
            { files, chunks: entries },
            `memory: plugin live with ${files} file${files === 1 ? "" : "s"} / ${entries} chunk${entries === 1 ? "" : "s"} indexed`,
        );
    }

    private isIncluded(relativePath: string): boolean {
        return !matchesAnyGlob(this.opts.excludeGlobs, relativePath);
    }

    private schema() {
        return {
            path: "string",
            lastModified: "number",
            headlines: "string",
            context: "string",
            content: "string",
            contentHash: "string",
            embedding: `vector[${this.opts.dimension}]`,
        } as const;
    }
}

interface StoredDoc {
    readonly id: string;
    readonly path: string;
    readonly lastModified: number;
    readonly headlines: string;
    readonly context: string;
    readonly content: string;
    readonly contentHash: string;
}

function rawToInsertable(doc: StoredDoc) {
    return {
        id: doc.id,
        path: doc.path,
        lastModified: doc.lastModified,
        headlines: doc.headlines,
        context: doc.context,
        content: doc.content,
        contentHash: doc.contentHash,
    };
}

/** Embedding input = headline trail, context, and content joined with blank lines. */
function buildEmbeddingInput(chunk: Chunk): string {
    const parts: string[] = [chunk.headlines];
    if (chunk.context) {
        parts.push(chunk.context);
    }
    parts.push(chunk.content);
    return parts.join("\n\n");
}

/** Stable per-chunk identity used both as Orama id seed and as diff key. */
function chunkHash(chunk: Chunk): string {
    return createHash("sha256")
        .update(`${chunk.headlines}\n\n${chunk.context}\n\n${chunk.content}`)
        .digest("hex")
        .slice(0, SHA_LEN);
}

/** Strip a single pair of matching surrounding quotes, if present. */
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

/** Normalise a (possibly >1) hybrid score to [0,1] for the threshold gates. */
function normalizeScore(raw: number): number {
    if (!Number.isFinite(raw)) {
        return 0;
    }
    if (raw <= 0) {
        return 0;
    }
    if (raw >= 1) {
        return 1;
    }
    return raw;
}

/** Walk the Map in insertion order and pop its first entry. */
function takeFirst<K, V>(map: Map<K, V>): [K, V] | undefined {
    const it = map.entries().next();
    if (it.done) {
        return undefined;
    }
    const [k, v] = it.value;
    map.delete(k);
    return [k, v];
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}
