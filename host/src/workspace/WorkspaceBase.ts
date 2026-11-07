import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Bookkeeping persisted in `data/workspace-base/state.json`. */
interface WorkspaceBaseState {
    readonly version: 1;
    /** Workspace-relative path → source that shipped the recorded base. */
    readonly files: Record<string, { readonly source: string }>;
    /** Update-note id → ISO timestamp it was recorded as done. */
    readonly notesDone: Record<string, string>;
}

/** One recorded base: the template version a workspace file was last synced to. */
export interface BaseEntry {
    readonly source: string;
    readonly content: string;
}

/**
 * The base of the workspace 3-way merge: per workspace file the template
 * version it was last synced to (`<baseDir>/files/<path>`), plus which
 * update notes are done (`<baseDir>/state.json`). A file's base only
 * moves when that file is resolved, so an undecided conflict keeps its
 * original base across later template versions.
 *
 * Mutations are buffered for `state.json` until {@link save}; base file
 * contents are written immediately (they are only read through an entry
 * in `state.json`, so a crash before `save` leaves at worst a stale,
 * unreferenced file).
 */
export class WorkspaceBaseStore {
    private readonly baseDir: string;
    private readonly filesDir: string;
    private readonly stateFile: string;
    private state: WorkspaceBaseState;
    /** `true` when no `state.json` existed at load time: first sync of this home. */
    readonly isFirstRun: boolean;

    /**
     * Load the store from `baseDir`; a missing directory or state file
     * yields an empty store with {@link isFirstRun} set.
     *
     * @param baseDir Absolute `data/workspace-base/` path.
     * @throws {Error} When `state.json` exists but is not valid JSON of the expected shape.
     */
    constructor(baseDir: string) {
        this.baseDir = baseDir;
        this.filesDir = path.join(baseDir, "files");
        this.stateFile = path.join(baseDir, "state.json");
        if (!existsSync(this.stateFile)) {
            this.isFirstRun = true;
            this.state = { version: 1, files: {}, notesDone: {} };
            return;
        }
        this.isFirstRun = false;
        const parsed = JSON.parse(
            readFileSync(this.stateFile, "utf8"),
        ) as Partial<WorkspaceBaseState>;
        if (parsed.version !== 1 || typeof parsed.files !== "object" || parsed.files === null) {
            throw new Error(
                `workspace base state ${this.stateFile} has an unexpected shape; delete data/workspace-base/ to start over (every file then counts as never synced)`,
            );
        }
        this.state = {
            version: 1,
            files: { ...parsed.files },
            notesDone: { ...(parsed.notesDone ?? {}) },
        };
    }

    /**
     * Recorded base of a workspace file.
     *
     * @param relativePath Workspace-relative path (the reference path).
     * @returns The entry, or `null` when none is recorded (or its content file went missing).
     */
    get(relativePath: string): BaseEntry | null {
        const record = this.state.files[relativePath];
        if (record === undefined) {
            return null;
        }
        const contentFile = path.join(this.filesDir, relativePath);
        if (!existsSync(contentFile)) {
            return null;
        }
        return { source: record.source, content: readFileSync(contentFile, "utf8") };
    }

    /**
     * Every path with a recorded base.
     *
     * @returns Workspace-relative paths.
     */
    listPaths(): string[] {
        return Object.keys(this.state.files).sort();
    }

    /**
     * Record `content` as the new base of a file.
     *
     * @param relativePath Workspace-relative path.
     * @param source Source that ships the template version.
     * @param content The template content.
     */
    set(relativePath: string, source: string, content: string): void {
        const contentFile = path.join(this.filesDir, relativePath);
        mkdirSync(path.dirname(contentFile), { recursive: true });
        writeFileSync(contentFile, content);
        this.state.files[relativePath] = { source };
    }

    /**
     * Forget the base of a file (template no longer ships it).
     *
     * @param relativePath Workspace-relative path.
     */
    remove(relativePath: string): void {
        delete this.state.files[relativePath];
        rmSync(path.join(this.filesDir, relativePath), { force: true });
    }

    /**
     * Whether an update note is recorded as done.
     *
     * @param noteId Note id (`<source>/<name>`).
     * @returns `true` when done.
     */
    isNoteDone(noteId: string): boolean {
        return this.state.notesDone[noteId] !== undefined;
    }

    /**
     * Record an update note as done.
     *
     * @param noteId Note id (`<source>/<name>`).
     * @param doneAt When it was done (defaults to now).
     */
    markNoteDone(noteId: string, doneAt: Date = new Date()): void {
        this.state.notesDone[noteId] = doneAt.toISOString();
    }

    /** Persist `state.json` atomically (write + rename). */
    save(): void {
        mkdirSync(this.baseDir, { recursive: true });
        const tempFile = `${this.stateFile}.tmp`;
        writeFileSync(tempFile, `${JSON.stringify(this.state, null, 2)}\n`);
        renameSync(tempFile, this.stateFile);
    }
}
