import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import git from "isomorphic-git";

/** Commit identity of every workspace commit the host makes. */
const FAMILIAR_AUTHOR = { name: "Familiar", email: "familiar@localhost" } as const;

/** `.gitignore` written into a workspace that has none. */
const DEFAULT_GITIGNORE = [
    "# Written by familiar's workspace updater; edit freely.",
    "# Syncthing bookkeeping is per machine and not part of the history.",
    ".stfolder",
    ".stversions/",
    ".stignore",
    "",
].join("\n");

/**
 * The workspace as a git repository: history and undo for everything the
 * workspace updater (and, via snapshots, anyone else) changes. Implemented
 * with isomorphic-git so the host needs no system `git`; the result is a
 * normal `.git` that any git client can read (e.g. the agent container's
 * `git log` via the bash tool).
 *
 * Only the host writes the repository — the container never touches
 * `.git`, which keeps file ownership consistent and `.git` out of the
 * agent's writable paths.
 */
export class WorkspaceGit {
    private readonly dir: string;

    /**
     * @param workspaceDir Absolute workspace root.
     */
    constructor(workspaceDir: string) {
        this.dir = workspaceDir;
    }

    /**
     * Make sure the workspace is a git repository. Creates `.gitignore`
     * when missing and — when the workspace is a Syncthing folder
     * (`.stfolder` exists) — lists `.git` in `.stignore` *before* the repo
     * exists: every machine keeps its own history, a synced `.git` written
     * by two machines would get corrupted.
     *
     * @returns `true` when the repository was created by this call.
     */
    async ensureRepository(): Promise<boolean> {
        if (existsSync(path.join(this.dir, ".stfolder"))) {
            ensureLine(path.join(this.dir, ".stignore"), ".git");
        }
        if (existsSync(path.join(this.dir, ".git"))) {
            return false;
        }
        const gitignore = path.join(this.dir, ".gitignore");
        if (!existsSync(gitignore)) {
            writeFileSync(gitignore, DEFAULT_GITIGNORE);
        }
        await git.init({ fs, dir: this.dir, defaultBranch: "main" });
        return true;
    }

    /**
     * Stage every change in the workspace (new, modified, deleted files,
     * respecting `.gitignore`) and commit it.
     *
     * @param message Commit message.
     * @returns The short commit id, or `null` when nothing changed.
     */
    async commitAll(message: string): Promise<string | null> {
        const matrix = await git.statusMatrix({ fs, dir: this.dir });
        return this.stageAndCommit(matrix, message);
    }

    /**
     * Stage the given paths only (added, modified or deleted) and commit.
     * Other pending changes stay uncommitted.
     *
     * @param relativePaths Workspace-relative paths.
     * @param message Commit message.
     * @returns The short commit id, or `null` when none of the paths changed.
     */
    async commitPaths(relativePaths: readonly string[], message: string): Promise<string | null> {
        if (relativePaths.length === 0) {
            return null;
        }
        const matrix = await git.statusMatrix({
            fs,
            dir: this.dir,
            filepaths: [...relativePaths],
        });
        // statusMatrix lists a deleted, previously committed file only when
        // asked for it explicitly; filepaths does that. It also matches
        // prefixes, so filter to the exact paths.
        const wanted = new Set(relativePaths);
        return this.stageAndCommit(
            matrix.filter(([filepath]) => wanted.has(filepath)),
            message,
        );
    }

    /**
     * Apply a status matrix to the index and commit when it changed anything.
     *
     * @param matrix Rows of `[filepath, head, workdir, stage]` from statusMatrix.
     * @param message Commit message.
     * @returns The short commit id, or `null` when there was nothing to commit.
     */
    private async stageAndCommit(
        matrix: ReadonlyArray<readonly [string, number, number, number]>,
        message: string,
    ): Promise<string | null> {
        let hasChanges = false;
        for (const [filepath, head, workdir, stage] of matrix) {
            if (head === 1 && workdir === 1 && stage === 1) {
                continue;
            }
            if (workdir === 0) {
                if (head === 0 && stage === 0) {
                    continue;
                }
                await git.remove({ fs, dir: this.dir, filepath });
            } else {
                await git.add({ fs, dir: this.dir, filepath });
            }
            hasChanges = true;
        }
        if (!hasChanges) {
            return null;
        }
        const oid = await git.commit({ fs, dir: this.dir, message, author: FAMILIAR_AUTHOR });
        return oid.slice(0, 7);
    }
}

/**
 * Append `line` to a text file unless a line with exactly that content
 * exists already; creates the file when missing.
 *
 * @param file Absolute file path.
 * @param line Line to ensure.
 */
function ensureLine(file: string, line: string): void {
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current.split(/\r?\n/).some((existing) => existing.trim() === line)) {
        return;
    }
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    writeFileSync(file, `${current}${separator}${line}\n`);
}
