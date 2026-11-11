import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseApi, DatabaseQuery, Logger } from "@getfamiliar/shared";
import { type ParsedWikiFile, parseWikiFile } from "./WikiParser.js";
import { normalizeText } from "./WikiText.js";

/** The folder (workspace-relative) whose markdown files are indexed. */
export const WIKI_FOLDER = "wiki";

/** Postgres schema of the live index. */
export const LIVE_INDEX_SCHEMA = "memory";

/**
 * Mixed into every content hash. Bump it whenever the parser or the stored columns change, so
 * every file is re-indexed on the next sync even though its content is the same.
 */
const INDEX_FORMAT_VERSION = "1";

/** Postgres identifiers we interpolate into SQL must match this. */
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** Result of a full directory sync. */
export interface SyncSummary {
    /** Files written because they were new or changed. */
    readonly written: number;
    /** Files whose content was unchanged. */
    readonly unchanged: number;
    /** Index entries removed because their file is gone. */
    readonly removed: number;
}

/**
 * The wiki index in postgres: one row per file (`files`), one per non-blank line (`lines`, with a
 * trigram index and a `simple` tsvector) and one per date occurrence (`dates`). All tables live in
 * one postgres schema, so the live index (`memory`) and eval indexes (`memory_eval_de`, …) sit side
 * by side in the same database.
 */
export class WikiIndex {
    private readonly database: DatabaseApi;
    /** Validated postgres schema name. */
    readonly schema: string;
    private readonly log: Logger;
    /** Serializes writes so a watcher burst can't interleave transactions on the same file. */
    private writeChain: Promise<unknown> = Promise.resolve();

    /**
     * @param database - The host's SQL access (`ctx.database`).
     * @param schema - Postgres schema holding the tables.
     * @param log - Logger for warnings about individual files.
     * @throws {Error} When `schema` is not a plain lower-case identifier.
     */
    constructor(database: DatabaseApi, schema: string, log: Logger) {
        if (!SCHEMA_NAME_PATTERN.test(schema)) {
            throw new Error(`memory: invalid index schema name ${JSON.stringify(schema)}`);
        }
        this.database = database;
        this.schema = schema;
        this.log = log;
    }

    /** The database handle, for the search queries. */
    get db(): DatabaseApi {
        return this.database;
    }

    /**
     * Creates the extension, the schema, the tables and their indexes if missing. Idempotent.
     *
     * @returns Resolves once the schema exists.
     */
    async ensureSchema(): Promise<void> {
        const s = this.schema;
        await this.database.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
        await this.database.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
        await this.database.query(`
            CREATE TABLE IF NOT EXISTS ${s}.files (
                path             text PRIMARY KEY,
                title            text NOT NULL,
                title_norm       text NOT NULL,
                description      text NOT NULL,
                description_norm text NOT NULL,
                categories       text[] NOT NULL DEFAULT '{}',
                review_at        date,
                last_touched     date NOT NULL,
                content_hash     text NOT NULL
            );
            CREATE INDEX IF NOT EXISTS files_title_trgm ON ${s}.files USING gin (title_norm gin_trgm_ops);
            CREATE INDEX IF NOT EXISTS files_description_trgm ON ${s}.files USING gin (description_norm gin_trgm_ops);
            CREATE INDEX IF NOT EXISTS files_categories ON ${s}.files USING gin (categories);
            CREATE INDEX IF NOT EXISTS files_review_at ON ${s}.files (review_at) WHERE review_at IS NOT NULL;

            CREATE TABLE IF NOT EXISTS ${s}.lines (
                path          text NOT NULL REFERENCES ${s}.files (path) ON DELETE CASCADE,
                line_no       integer NOT NULL,
                is_heading    boolean NOT NULL,
                heading_trail text NOT NULL,
                text          text NOT NULL,
                text_norm     text NOT NULL,
                tsv           tsvector NOT NULL,
                PRIMARY KEY (path, line_no)
            );
            CREATE INDEX IF NOT EXISTS lines_text_trgm ON ${s}.lines USING gin (text_norm gin_trgm_ops);
            CREATE INDEX IF NOT EXISTS lines_tsv ON ${s}.lines USING gin (tsv);

            CREATE TABLE IF NOT EXISTS ${s}.dates (
                path      text NOT NULL REFERENCES ${s}.files (path) ON DELETE CASCADE,
                line_no   integer NOT NULL,
                date_from date NOT NULL,
                date_to   date NOT NULL,
                month_day text,
                snippet   text NOT NULL,
                PRIMARY KEY (path, line_no, date_from, date_to)
            );
            CREATE INDEX IF NOT EXISTS dates_range ON ${s}.dates (date_from, date_to);
            CREATE INDEX IF NOT EXISTS dates_month_day ON ${s}.dates (month_day) WHERE month_day IS NOT NULL;

            CREATE TABLE IF NOT EXISTS ${s}.dedup_pairs (
                path_a     text NOT NULL,
                path_b     text NOT NULL,
                size_a     integer NOT NULL,
                size_b     integer NOT NULL,
                handled_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (path_a, path_b),
                CHECK (path_a < path_b)
            );
        `);
    }

    /**
     * Drops the whole schema. Used by the eval to start from scratch.
     *
     * @returns Resolves once dropped.
     */
    async dropSchema(): Promise<void> {
        await this.database.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
    }

    /**
     * Indexes one file (re-reading it from disk). Skips the write when content and date are
     * unchanged. A missing file is removed from the index instead.
     *
     * @param rootDir - Directory the relative path is resolved against (the workspace).
     * @param relativePath - POSIX path relative to `rootDir`, e.g. `wiki/people/alice.md`.
     * @returns `"written"`, `"unchanged"` or `"removed"`.
     */
    indexFile(rootDir: string, relativePath: string): Promise<"written" | "unchanged" | "removed"> {
        return this.serialize(() => this.indexFileNow(rootDir, relativePath));
    }

    /**
     * Removes a file from the index.
     *
     * @param relativePath - The indexed path.
     * @returns Resolves once removed.
     */
    removeFile(relativePath: string): Promise<void> {
        return this.serialize(async () => {
            await this.database.query(`DELETE FROM ${this.schema}.files WHERE path = $1`, [
                relativePath,
            ]);
        });
    }

    /**
     * Brings the index in line with every markdown file under `<rootDir>/wiki/`: writes new and
     * changed files, removes entries whose file is gone.
     *
     * @param rootDir - The workspace (or eval corpus) root.
     * @returns Counts of what happened.
     */
    async syncAll(rootDir: string): Promise<SyncSummary> {
        const onDisk = await listWikiFiles(rootDir);
        const indexed = await this.database.query<{ path: string }>(
            `SELECT path FROM ${this.schema}.files`,
        );
        const live = new Set(onDisk);
        let written = 0;
        let unchanged = 0;
        let removed = 0;
        for (const relativePath of onDisk) {
            const outcome = await this.indexFile(rootDir, relativePath);
            if (outcome === "written") {
                written++;
            } else if (outcome === "unchanged") {
                unchanged++;
            }
        }
        for (const row of indexed) {
            if (!live.has(row.path)) {
                await this.removeFile(row.path);
                removed++;
            }
        }
        return { written, unchanged, removed };
    }

    /**
     * Counts the indexed files.
     *
     * @returns Number of rows in `files`.
     */
    async countFiles(): Promise<number> {
        const rows = await this.database.query<{ count: string }>(
            `SELECT count(*) AS count FROM ${this.schema}.files`,
        );
        return Number(rows[0]?.count ?? 0);
    }

    /**
     * Lists the files whose `review_at` is due.
     *
     * @param today - ISO date of today in the user's time zone.
     * @returns Path and `review_at` of every file with `review_at <= today`, oldest first.
     */
    async listDueReviews(today: string): Promise<readonly { path: string; reviewAt: string }[]> {
        return this.database.query<{ path: string; reviewAt: string }>(
            `SELECT path, to_char(review_at, 'YYYY-MM-DD') AS "reviewAt" FROM ${this.schema}.files
             WHERE review_at <= $1::date ORDER BY review_at, path`,
            [today],
        );
    }

    /**
     * Lists title and description of every indexed file in a folder (sub-folders included).
     *
     * @param folderPrefix - Workspace-relative folder, e.g. `wiki/people`.
     * @returns The files, sorted by path.
     */
    async listFolderEntries(
        folderPrefix: string,
    ): Promise<readonly { path: string; title: string; description: string }[]> {
        return this.database.query<{ path: string; title: string; description: string }>(
            `SELECT path, title, description FROM ${this.schema}.files
             WHERE starts_with(path, $1) ORDER BY path`,
            [`${folderPrefix.replace(/\/+$/, "")}/`],
        );
    }

    /**
     * Runs `work` after every previously queued write.
     *
     * @param work - The write.
     * @returns Its result.
     */
    private serialize<T>(work: () => Promise<T>): Promise<T> {
        const next = this.writeChain.then(work, work);
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    /**
     * Implementation of {@link indexFile}, run inside the write chain.
     *
     * @param rootDir - Root directory.
     * @param relativePath - Relative path.
     * @returns The outcome.
     */
    private async indexFileNow(
        rootDir: string,
        relativePath: string,
    ): Promise<"written" | "unchanged" | "removed"> {
        const absolutePath = path.join(rootDir, relativePath);
        let content: string;
        let lastTouched: string;
        try {
            const [text, stat] = await Promise.all([
                fs.readFile(absolutePath, "utf8"),
                fs.stat(absolutePath),
            ]);
            content = text;
            lastTouched = formatLocalDate(stat.mtime);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                await this.database.query(`DELETE FROM ${this.schema}.files WHERE path = $1`, [
                    relativePath,
                ]);
                return "removed";
            }
            throw err;
        }
        const contentHash = createHash("sha256")
            .update(INDEX_FORMAT_VERSION)
            .update("\0")
            .update(content)
            .digest("hex");
        const existing = await this.database.query<{ content_hash: string; last_touched: string }>(
            `SELECT content_hash, to_char(last_touched, 'YYYY-MM-DD') AS last_touched FROM ${this.schema}.files WHERE path = $1`,
            [relativePath],
        );
        if (existing[0]?.content_hash === contentHash) {
            if (existing[0].last_touched !== lastTouched) {
                await this.database.query(
                    `UPDATE ${this.schema}.files SET last_touched = $2 WHERE path = $1`,
                    [relativePath, lastTouched],
                );
            }
            return "unchanged";
        }
        const parsed = parseWikiFile(relativePath, content);
        for (const warning of parsed.warnings) {
            this.log.warn(`memory: ${relativePath}: ${warning}`);
        }
        await this.database.transaction((query) =>
            writeFile(query, this.schema, relativePath, parsed, lastTouched, contentHash),
        );
        return "written";
    }
}

/**
 * Replaces a file's rows in one transaction.
 *
 * @param query - Transaction-bound query function.
 * @param schema - Validated schema name.
 * @param relativePath - Indexed path.
 * @param parsed - The parsed file.
 * @param lastTouched - ISO date of the file's mtime.
 * @param contentHash - SHA-256 of the content.
 * @returns Resolves once written.
 */
async function writeFile(
    query: DatabaseQuery,
    schema: string,
    relativePath: string,
    parsed: ParsedWikiFile,
    lastTouched: string,
    contentHash: string,
): Promise<void> {
    await query(`DELETE FROM ${schema}.files WHERE path = $1`, [relativePath]);
    await query(
        `INSERT INTO ${schema}.files
            (path, title, title_norm, description, description_norm, categories, review_at, last_touched, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
            relativePath,
            parsed.title,
            normalizeText(parsed.title),
            parsed.description,
            normalizeText(parsed.description),
            parsed.categories,
            parsed.reviewAt ?? null,
            lastTouched,
            contentHash,
        ],
    );
    if (parsed.lines.length > 0) {
        await query(
            `INSERT INTO ${schema}.lines (path, line_no, is_heading, heading_trail, text, text_norm, tsv)
             SELECT $1, l.line_no, l.is_heading, l.heading_trail, l.text, l.text_norm, to_tsvector('simple', l.text_norm)
             FROM unnest($2::int[], $3::boolean[], $4::text[], $5::text[], $6::text[])
                 AS l(line_no, is_heading, heading_trail, text, text_norm)`,
            [
                relativePath,
                parsed.lines.map((line) => line.lineNo),
                parsed.lines.map((line) => line.isHeading),
                parsed.lines.map((line) => line.headingTrail),
                parsed.lines.map((line) => line.text),
                parsed.lines.map((line) => normalizeText(line.text)),
            ],
        );
    }
    if (parsed.dates.length > 0) {
        await query(
            `INSERT INTO ${schema}.dates (path, line_no, date_from, date_to, month_day, snippet)
             SELECT $1, d.line_no, d.date_from, d.date_to,
                    CASE WHEN d.date_from = d.date_to THEN to_char(d.date_from, 'MM-DD') END, d.snippet
             FROM unnest($2::int[], $3::date[], $4::date[], $5::text[]) AS d(line_no, date_from, date_to, snippet)
             ON CONFLICT DO NOTHING`,
            [
                relativePath,
                parsed.dates.map((date) => date.lineNo),
                parsed.dates.map((date) => date.from),
                parsed.dates.map((date) => date.to),
                parsed.dates.map((date) => date.snippet),
            ],
        );
    }
}

/**
 * Lists every markdown file under `<rootDir>/wiki/`, as sorted POSIX paths relative to `rootDir`.
 * Hidden files and folders (starting with `.`) are skipped.
 *
 * @param rootDir - Workspace root.
 * @returns Relative paths such as `wiki/people/alice.md`; empty when there is no wiki folder.
 */
export async function listWikiFiles(rootDir: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (relativeDir: string): Promise<void> => {
        let entries: import("node:fs").Dirent[];
        try {
            entries = await fs.readdir(path.join(rootDir, relativeDir), { withFileTypes: true });
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                return;
            }
            throw err;
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".")) {
                continue;
            }
            const relativePath = `${relativeDir}/${entry.name}`;
            if (entry.isDirectory()) {
                await walk(relativePath);
            } else if (entry.isFile() && entry.name.endsWith(".md")) {
                found.push(relativePath);
            }
        }
    };
    await walk(WIKI_FOLDER);
    return found.sort();
}

/**
 * Checks whether a workspace-relative path belongs to the indexed wiki.
 *
 * @param relativePath - POSIX path relative to the workspace.
 * @returns `true` for a non-hidden `.md` file under `wiki/`.
 */
export function isWikiPath(relativePath: string): boolean {
    return (
        relativePath.startsWith(`${WIKI_FOLDER}/`) &&
        relativePath.endsWith(".md") &&
        !relativePath.split("/").some((segment) => segment.startsWith("."))
    );
}

/**
 * Formats a timestamp as the local calendar date.
 *
 * @param date - The timestamp.
 * @returns ISO `YYYY-MM-DD` in the process's time zone.
 */
function formatLocalDate(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
}
