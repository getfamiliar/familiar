import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { twinHandlerPath } from "@getfamiliar/shared";
import { createTwoFilesPatch } from "diff";
import { merge } from "node-diff3";
import { WorkspaceBaseStore } from "./WorkspaceBase.js";
import type { WorkspaceGit } from "./WorkspaceGit.js";
import {
    buildWorkspaceReference,
    listUpdateNotes,
    type ReferenceFile,
    type TemplateSource,
    type UpdateNote,
} from "./WorkspaceReference.js";

/**
 * Why a file needs a decision:
 * - `both-changed`: template and workspace both changed since the last sync.
 * - `unknown-base`: no sync recorded (first run of an existing workspace, or the
 *   user created a file at a path a template now ships) and the file differs.
 * - `live-deleted`: the user deleted the file, the template changed it since.
 * - `template-deleted`: the template dropped the file, the user had changed it.
 */
export type PendingKind = "both-changed" | "unknown-base" | "live-deleted" | "template-deleted";

/** What the updater did on its own. */
export type AppliedKind = "seeded" | "fast-forwarded" | "removed";

/** A file that needs a decision by the update agent (or the user). */
export interface PendingFile {
    /** Reference path (template path). */
    readonly path: string;
    /** Path of the workspace file, or `null` when it does not exist. Differs from `path` for a twin handler form. */
    readonly livePath: string | null;
    readonly source: string;
    readonly kind: PendingKind;
}

/** A change the updater applied without asking. */
export interface AppliedChange {
    readonly path: string;
    readonly source: string;
    readonly kind: AppliedKind;
}

/** Result of {@link WorkspaceUpdater.sync}. */
export interface SyncReport {
    readonly applied: readonly AppliedChange[];
    readonly pending: readonly PendingFile[];
    readonly pendingNotes: readonly UpdateNote[];
    /** Commit of the snapshot taken before syncing, `null` when nothing had changed or git is unavailable. */
    readonly snapshotCommit: string | null;
    /** Commit of the automatic changes, `null` when there were none or git is unavailable. */
    readonly updateCommit: string | null;
    /** Set when git failed; overwrites and removals were then skipped. */
    readonly gitError: string | null;
}

/** Everything the agent needs to decide one pending file. */
export interface PendingFileDetails extends PendingFile {
    /** Unified diff last-synced template → current template, `null` without a base. */
    readonly templateChanges: string | null;
    /** Unified diff last-synced template → workspace file, `null` without a base or live file. */
    readonly localChanges: string | null;
    /** Unified diff workspace file → current template (always useful, the only diff for `unknown-base`). */
    readonly liveToTemplate: string | null;
    /** 3-way merge of the two change sets, `null` when not applicable. */
    readonly mergeProposal: { readonly hasConflicts: boolean; readonly content: string } | null;
    /** Current template content, `null` for `template-deleted`. */
    readonly templateContent: string | null;
}

/** How a pending file was decided. */
export type Resolution = "use_template" | "accept_live";

/** Result of resolving a pending file. */
export interface ResolveResult {
    readonly path: string;
    readonly livePath: string | null;
    readonly resolution: Resolution;
    /** What happened to the workspace file. */
    readonly action: "written" | "removed" | "unchanged";
    readonly commit: string | null;
}

/** Internal per-file verdict of a classification pass. */
type Verdict =
    | { readonly type: "none" }
    | { readonly type: "record-base"; readonly reference: ReferenceFile }
    | { readonly type: "drop-base" }
    | { readonly type: "apply"; readonly kind: AppliedKind }
    | { readonly type: "pending"; readonly pending: PendingFile };

/** Dependencies of {@link WorkspaceUpdater}. */
export interface WorkspaceUpdaterOptions {
    readonly workspaceDir: string;
    /** `data/workspace-base/`. */
    readonly baseDir: string;
    /** Template sources, core first; read again on every call (cheap, keeps tools current). */
    readonly sources: () => readonly TemplateSource[];
    /** Workspace repository; `null` disables history (tests, CLI read-only use). */
    readonly git: WorkspaceGit | null;
}

/** Commit message prefix of every updater commit. */
const COMMIT_PREFIX = "workspace update";

/**
 * Keeps the workspace in step with the templates of core and plugins — a
 * per-file 3-way merge with base = the template version a file was last
 * synced to (`data/workspace-base/`), theirs = the current template,
 * ours = the workspace file:
 *
 * | situation                                   | action                     |
 * |---------------------------------------------|----------------------------|
 * | template unchanged since base               | nothing                    |
 * | workspace file untouched (== base)          | fast-forward to template   |
 * | workspace file already equals the template  | record new base            |
 * | new template file, no workspace file        | seed                       |
 * | template dropped the file, file untouched   | remove                     |
 * | everything else                             | pending → update agent     |
 *
 * A file's base only advances when the file is settled, so an open
 * decision survives later template versions. Files of a source that is no
 * longer loaded (uninstalled plugin) are left alone.
 */
export class WorkspaceUpdater {
    private readonly options: WorkspaceUpdaterOptions;

    /**
     * @param options Paths, sources and repository.
     */
    constructor(options: WorkspaceUpdaterOptions) {
        this.options = options;
    }

    /**
     * Daemon-start sync: snapshot the workspace in git, apply every
     * decision that needs no judgment, commit it, and report what is left.
     * When git fails, seeding and base bookkeeping still run but nothing is
     * overwritten or removed (there would be no undo).
     *
     * @param version Host version, quoted in the commit message.
     * @returns What was applied and what is pending.
     */
    async sync(version: string): Promise<SyncReport> {
        let snapshotCommit: string | null = null;
        let gitError: string | null = null;
        if (this.options.git !== null) {
            try {
                await this.options.git.ensureRepository();
                snapshotCommit = await this.options.git.commitAll(
                    `${COMMIT_PREFIX}: snapshot before syncing templates of familiar ${version}`,
                );
            } catch (err) {
                gitError = err instanceof Error ? err.message : String(err);
            }
        }
        const isOverwriteAllowed = this.options.git !== null && gitError === null;

        const store = new WorkspaceBaseStore(this.options.baseDir);
        const sources = this.options.sources();
        const reference = buildWorkspaceReference(sources);
        const applied: AppliedChange[] = [];
        const pending: PendingFile[] = [];
        for (const [relativePath, verdict] of this.classify(store, reference, sources)) {
            switch (verdict.type) {
                case "none":
                    break;
                case "record-base":
                    store.set(relativePath, verdict.reference.source, verdict.reference.content);
                    break;
                case "drop-base":
                    store.remove(relativePath);
                    break;
                case "pending":
                    pending.push(verdict.pending);
                    break;
                case "apply": {
                    const change = this.applyAutomatic(
                        store,
                        relativePath,
                        verdict.kind,
                        reference.get(relativePath),
                        isOverwriteAllowed,
                    );
                    if (change !== null) {
                        applied.push(change);
                    }
                    break;
                }
            }
        }
        const notes = listUpdateNotes(sources);
        if (store.isFirstRun) {
            // A fresh install (or the first run of this feature) starts from
            // the current templates: historic notes describe migrations of
            // older states and must not run.
            for (const note of notes) {
                store.markNoteDone(note.id);
            }
        }
        store.save();

        let updateCommit: string | null = null;
        const changedPaths = applied.filter((change) => change.kind !== "seeded");
        if (isOverwriteAllowed && applied.length > 0 && this.options.git !== null) {
            try {
                updateCommit = await this.options.git.commitAll(
                    renderAutomaticCommitMessage(version, applied, changedPaths.length),
                );
            } catch (err) {
                gitError = err instanceof Error ? err.message : String(err);
            }
        }
        return {
            applied,
            pending,
            pendingNotes: notes.filter((note) => !store.isNoteDone(note.id)),
            snapshotCommit,
            updateCommit,
            gitError,
        };
    }

    /**
     * Current open items without changing anything.
     *
     * @returns Pending files and update notes not yet done.
     */
    status(): { pending: PendingFile[]; pendingNotes: UpdateNote[] } {
        const store = new WorkspaceBaseStore(this.options.baseDir);
        const sources = this.options.sources();
        const reference = buildWorkspaceReference(sources);
        const pending: PendingFile[] = [];
        for (const [, verdict] of this.classify(store, reference, sources)) {
            if (verdict.type === "pending") {
                pending.push(verdict.pending);
            }
        }
        const pendingNotes = store.isFirstRun
            ? []
            : listUpdateNotes(sources).filter((note) => !store.isNoteDone(note.id));
        return { pending, pendingNotes };
    }

    /**
     * Diffs and merge proposal for one pending file.
     *
     * @param relativePath Reference path or live path of a pending file.
     * @returns The details.
     * @throws {WorkspaceUpdateError} When the path is not pending.
     */
    details(relativePath: string): PendingFileDetails {
        const { pending, store, reference } = this.findPending(relativePath);
        const base = store.get(pending.path);
        const template = reference.get(pending.path)?.content ?? null;
        const live = pending.livePath === null ? null : this.readWorkspaceFile(pending.livePath);
        const livePath = pending.livePath ?? pending.path;
        const diff = (
            fromLabel: string,
            from: string | null,
            toLabel: string,
            to: string | null,
        ) =>
            from === null && to === null
                ? null
                : createTwoFilesPatch(fromLabel, toLabel, from ?? "", to ?? "", "", "", {
                      context: 3,
                  });
        let mergeProposal: PendingFileDetails["mergeProposal"] = null;
        if (base !== null && live !== null && template !== null) {
            const merged = merge(live, base.content, template, {
                stringSeparator: "\n",
                label: { a: "workspace", o: "last-synced template", b: "new template" },
            });
            mergeProposal = { hasConflicts: merged.conflict, content: merged.result.join("\n") };
        }
        return {
            ...pending,
            templateChanges:
                base === null
                    ? null
                    : diff(
                          `base/${pending.path}`,
                          base.content,
                          `template/${pending.path}`,
                          template,
                      ),
            localChanges:
                base === null || live === null
                    ? null
                    : diff(`base/${pending.path}`, base.content, `workspace/${livePath}`, live),
            liveToTemplate: diff(
                `workspace/${livePath}`,
                live,
                `template/${pending.path}`,
                template,
            ),
            mergeProposal,
            templateContent: template,
        };
    }

    /**
     * Settle a pending file and advance its base to the current template.
     *
     * - `use_template`: the workspace file becomes the template version (or is
     *   removed when the template dropped it).
     * - `accept_live`: the workspace file stays as it is — kept customization,
     *   a merge the agent already wrote, or a deletion the user wants to keep.
     *
     * @param relativePath Reference path or live path of a pending file.
     * @param resolution How it was decided.
     * @param summary One line on what was decided and why (commit message).
     * @returns What happened, with the commit id.
     * @throws {WorkspaceUpdateError} When the path is not pending.
     */
    async resolve(
        relativePath: string,
        resolution: Resolution,
        summary: string,
    ): Promise<ResolveResult> {
        const { pending, store, reference } = this.findPending(relativePath);
        const template = reference.get(pending.path) ?? null;
        const targetPath = pending.livePath ?? pending.path;
        let action: ResolveResult["action"] = "unchanged";
        if (resolution === "use_template") {
            if (template === null) {
                rmSync(path.join(this.options.workspaceDir, targetPath), { force: true });
                action = "removed";
            } else {
                this.writeWorkspaceFile(targetPath, template.content);
                action = "written";
            }
        }
        if (template === null) {
            store.remove(pending.path);
        } else {
            store.set(pending.path, template.source, template.content);
        }
        store.save();
        const commit =
            this.options.git === null
                ? null
                : await this.options.git.commitPaths(
                      [targetPath],
                      `${COMMIT_PREFIX}: ${targetPath} (${resolution}) — ${summary}`,
                  );
        return { path: pending.path, livePath: pending.livePath, resolution, action, commit };
    }

    /**
     * Record an update note as done and commit whatever the agent changed
     * in the workspace while applying it.
     *
     * @param noteId Note id (`<source>/<name>`).
     * @param summary One line on what was done (commit message).
     * @returns The commit id, or `null` when nothing changed.
     * @throws {WorkspaceUpdateError} When no pending note has this id.
     */
    async markNoteDone(noteId: string, summary: string): Promise<string | null> {
        const store = new WorkspaceBaseStore(this.options.baseDir);
        const note = listUpdateNotes(this.options.sources()).find((entry) => entry.id === noteId);
        if (note === undefined) {
            throw new WorkspaceUpdateError(
                "NotFound",
                `no update note "${noteId}" exists; workspace_update_status lists the pending notes`,
            );
        }
        if (store.isNoteDone(noteId)) {
            throw new WorkspaceUpdateError("NotPending", `update note "${noteId}" is already done`);
        }
        store.markNoteDone(noteId);
        store.save();
        return this.options.git === null
            ? null
            : await this.options.git.commitAll(`${COMMIT_PREFIX}: note ${noteId} — ${summary}`);
    }

    /**
     * Stable fingerprint of open items: identical when the same
     * decisions are open against the same file versions. The merge
     * coordinator uses it per item in the idempotency key of the
     * `update:merge-file` events, so a restart doesn't run the agent again
     * for a question it already raised.
     *
     * @param report Sync result.
     * @returns A short hex hash.
     */
    fingerprint(report: Pick<SyncReport, "pending" | "pendingNotes">): string {
        const hash = createHash("sha256");
        for (const item of report.pending) {
            hash.update(`${item.kind}\0${item.path}\0${item.livePath ?? ""}\0`);
            const live =
                item.livePath === null ? "" : (this.readWorkspaceFile(item.livePath) ?? "");
            hash.update(createHash("sha256").update(live).digest("hex"));
        }
        for (const note of report.pendingNotes) {
            hash.update(`note\0${note.id}\0`);
        }
        return hash.digest("hex").slice(0, 16);
    }

    /**
     * Classify every reference file and every recorded base.
     *
     * @param store Base store.
     * @param reference Current reference workspace.
     * @param sources Loaded sources.
     * @returns Verdicts by reference path.
     */
    private classify(
        store: WorkspaceBaseStore,
        reference: ReadonlyMap<string, ReferenceFile>,
        sources: readonly TemplateSource[],
    ): Map<string, Verdict> {
        const verdicts = new Map<string, Verdict>();
        for (const [relativePath, file] of reference) {
            verdicts.set(relativePath, this.classifyReferenceFile(store, file));
        }
        const loadedSources = new Set(sources.map((source) => source.id));
        for (const relativePath of store.listPaths()) {
            if (reference.has(relativePath)) {
                continue;
            }
            const base = store.get(relativePath);
            if (base === null) {
                verdicts.set(relativePath, { type: "drop-base" });
                continue;
            }
            if (!loadedSources.has(base.source)) {
                // Plugin uninstalled: not a template deletion, keep everything.
                continue;
            }
            const twin = twinHandlerPath(relativePath);
            if (twin !== null && reference.has(twin)) {
                // The template moved the handler to its twin form (x.md ↔
                // x/index.md). Whichever form the workspace has belongs to
                // the new template path now; the old base is superseded,
                // not a deletion.
                verdicts.set(relativePath, { type: "drop-base" });
                continue;
            }
            const livePath = this.resolveLivePath(relativePath);
            const live = livePath === null ? null : this.readWorkspaceFile(livePath);
            if (live === null) {
                verdicts.set(relativePath, { type: "drop-base" });
            } else if (live === base.content) {
                verdicts.set(relativePath, { type: "apply", kind: "removed" });
            } else {
                verdicts.set(relativePath, {
                    type: "pending",
                    pending: {
                        path: relativePath,
                        livePath,
                        source: base.source,
                        kind: "template-deleted",
                    },
                });
            }
        }
        return verdicts;
    }

    /**
     * Classify one template file against its base and workspace file.
     *
     * @param store Base store.
     * @param file The template file.
     * @returns The verdict.
     */
    private classifyReferenceFile(store: WorkspaceBaseStore, file: ReferenceFile): Verdict {
        const base = store.get(file.path);
        const livePath = this.resolveLivePath(file.path);
        const live = livePath === null ? null : this.readWorkspaceFile(livePath);
        const pendingAs = (kind: PendingKind): Verdict => ({
            type: "pending",
            pending: { path: file.path, livePath, source: file.source, kind },
        });
        if (base === null) {
            if (live === null) {
                return { type: "apply", kind: "seeded" };
            }
            return live === file.content
                ? { type: "record-base", reference: file }
                : pendingAs("unknown-base");
        }
        if (file.content === base.content) {
            // Template unchanged; keep the source current (a file can move between sources).
            return base.source === file.source
                ? { type: "none" }
                : { type: "record-base", reference: file };
        }
        if (live === null) {
            return pendingAs("live-deleted");
        }
        if (live === file.content) {
            return { type: "record-base", reference: file };
        }
        if (live === base.content) {
            return { type: "apply", kind: "fast-forwarded" };
        }
        return pendingAs("both-changed");
    }

    /**
     * Carry out an automatic verdict.
     *
     * @param store Base store.
     * @param relativePath Reference path.
     * @param kind What to do.
     * @param file Template file (absent for `removed`).
     * @param isOverwriteAllowed `false` when git is unavailable: only seeding runs.
     * @returns The applied change, or `null` when skipped.
     */
    private applyAutomatic(
        store: WorkspaceBaseStore,
        relativePath: string,
        kind: AppliedKind,
        file: ReferenceFile | undefined,
        isOverwriteAllowed: boolean,
    ): AppliedChange | null {
        if (kind === "seeded" && file !== undefined) {
            this.writeWorkspaceFile(relativePath, file.content);
            store.set(relativePath, file.source, file.content);
            return { path: relativePath, source: file.source, kind };
        }
        if (!isOverwriteAllowed) {
            return null;
        }
        const livePath = this.resolveLivePath(relativePath) ?? relativePath;
        if (kind === "fast-forwarded" && file !== undefined) {
            this.writeWorkspaceFile(livePath, file.content);
            store.set(relativePath, file.source, file.content);
            return { path: livePath, source: file.source, kind };
        }
        if (kind === "removed") {
            const source = store.get(relativePath)?.source ?? "unknown";
            rmSync(path.join(this.options.workspaceDir, livePath), { force: true });
            store.remove(relativePath);
            return { path: livePath, source, kind };
        }
        return null;
    }

    /**
     * Find a pending file by its reference or live path.
     *
     * @param relativePath Path as the agent gave it.
     * @returns The pending entry with the loaded store and reference.
     * @throws {WorkspaceUpdateError} When the path is not pending.
     */
    private findPending(relativePath: string): {
        pending: PendingFile;
        store: WorkspaceBaseStore;
        reference: Map<string, ReferenceFile>;
    } {
        const normalized = normalizeRelativePath(relativePath);
        const store = new WorkspaceBaseStore(this.options.baseDir);
        const sources = this.options.sources();
        const reference = buildWorkspaceReference(sources);
        for (const [, verdict] of this.classify(store, reference, sources)) {
            if (
                verdict.type === "pending" &&
                (verdict.pending.path === normalized || verdict.pending.livePath === normalized)
            ) {
                return { pending: verdict.pending, store, reference };
            }
        }
        throw new WorkspaceUpdateError(
            "NotPending",
            `"${relativePath}" has no open workspace update decision; workspace_update_status lists the open ones`,
        );
    }

    /**
     * Workspace path holding the file for a reference path: the path
     * itself, else its twin handler form (`x.md` ↔ `x/index.md`).
     *
     * @param relativePath Reference path.
     * @returns The existing workspace path, or `null`.
     */
    private resolveLivePath(relativePath: string): string | null {
        if (existsSync(path.join(this.options.workspaceDir, relativePath))) {
            return relativePath;
        }
        const twin = twinHandlerPath(relativePath);
        if (twin !== null && existsSync(path.join(this.options.workspaceDir, twin))) {
            return twin;
        }
        return null;
    }

    /**
     * @param relativePath Workspace-relative path.
     * @returns The file content, or `null` when it doesn't exist.
     */
    private readWorkspaceFile(relativePath: string): string | null {
        const file = path.join(this.options.workspaceDir, relativePath);
        return existsSync(file) ? readFileSync(file, "utf8") : null;
    }

    /**
     * @param relativePath Workspace-relative path.
     * @param content New content.
     */
    private writeWorkspaceFile(relativePath: string, content: string): void {
        const file = path.join(this.options.workspaceDir, relativePath);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
    }
}

/** Failure the agent tools turn into a `ToolError` with the same code. */
export class WorkspaceUpdateError extends Error {
    readonly code: "NotPending" | "NotFound" | "InvalidArgument";

    /**
     * @param code Stable error code.
     * @param message Self-contained message.
     */
    constructor(code: WorkspaceUpdateError["code"], message: string) {
        super(message);
        this.name = "WorkspaceUpdateError";
        this.code = code;
    }
}

/**
 * Normalize an agent-given path: strip a leading `/workspace/` or `./`,
 * use forward slashes, refuse `..`.
 *
 * @param relativePath Path as given.
 * @returns Workspace-relative posix path.
 * @throws {WorkspaceUpdateError} When the path escapes the workspace.
 */
export function normalizeRelativePath(relativePath: string): string {
    const posix = relativePath
        .trim()
        .replaceAll("\\", "/")
        .replace(/^\/workspace\//, "");
    const normalized = path.posix.normalize(posix).replace(/^(\.\/)+/, "");
    if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
        throw new WorkspaceUpdateError(
            "InvalidArgument",
            `"${relativePath}" is not a workspace-relative path (e.g. chat/web.md)`,
        );
    }
    return normalized;
}

/**
 * Commit message for the automatic changes of one sync.
 *
 * @param version Host version.
 * @param applied The applied changes.
 * @param changedCount Count of non-seed changes.
 * @returns The message.
 */
function renderAutomaticCommitMessage(
    version: string,
    applied: readonly AppliedChange[],
    changedCount: number,
): string {
    const subject =
        changedCount === 0
            ? `${COMMIT_PREFIX}: seeded ${applied.length} new template file(s) of familiar ${version}`
            : `${COMMIT_PREFIX}: applied ${applied.length} template change(s) of familiar ${version}`;
    const lines = applied.map((change) => `- ${change.kind}: ${change.path} (${change.source})`);
    return `${subject}\n\n${lines.join("\n")}\n`;
}
