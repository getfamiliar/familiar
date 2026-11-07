import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
    BANNER_MAX_TEXT_CHARS,
    DuplicateIdempotencyKeyError,
    type EmitHandle,
    EVENT_PRIORITY,
    type Logger,
    type NewBanner,
    type NewEvent,
} from "@getfamiliar/shared";
import { DateTime } from "luxon";
import type { WorkspaceGit } from "./WorkspaceGit.js";
import type { PendingFile, SyncReport, WorkspaceUpdater } from "./WorkspaceUpdater.js";

/** Topic of the agent run that merges one workspace file with its new template. */
export const WORKSPACE_MERGE_FILE_TOPIC = "update:merge-file";

/** Topic of the agent run that applies one update note. */
export const WORKSPACE_APPLY_NOTE_TOPIC = "update:apply-note";

/** Lifetime of the banners about a workspace update. */
const BANNER_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

/** Workspace folder the update reports go to. */
const REPORT_DIR = "files/updates";

/** One open item the coordinator hands to an agent run. */
type WorkItem =
    | { readonly type: "note"; readonly id: string }
    | { readonly type: "file"; readonly file: PendingFile };

/** What became of one work item. */
interface ItemOutcome {
    readonly label: string;
    /** `decided`: no longer pending afterwards; `open`: still pending; `earlier`: handed over by an earlier start already. */
    readonly status: "decided" | "open" | "earlier";
    /** The run's one-line answer or its error. */
    readonly text: string;
}

/** Dependencies of {@link WorkspaceMergeCoordinator}. */
export interface WorkspaceMergeCoordinatorDeps {
    readonly report: SyncReport;
    readonly updater: WorkspaceUpdater;
    /** Event emission (the core host context, which stamps the default chat channel). */
    readonly emit: (event: NewEvent) => Promise<EmitHandle>;
    readonly banners: { create(banner: NewBanner): Promise<unknown> };
    readonly workspaceDir: string;
    /** Commits the report; `null` without history. */
    readonly git: WorkspaceGit | null;
    /** `core.timezone`, for the report date. */
    readonly timezone: string;
    readonly version: string;
    readonly log: Logger;
}

/**
 * Settles what the daemon-start sync left open, one agent run per item:
 * update notes first (they may move or rename files), then every pending
 * file. Each item is its own exact, privileged event
 * (`update:apply-note` / `update:merge-file`) with a full tool budget; the
 * coordinator waits for it, so the runs go one after another, then writes
 * the report to `files/updates/<date>.md` and the banners itself — no model
 * orchestrates, so there is no limit on the number of items.
 *
 * Idempotency keys fingerprint each item, so an item an earlier start
 * already handed over (and the agent left open as a question) is not run
 * again for the same file versions. Without open items only the banner
 * about automatic changes is written.
 */
export class WorkspaceMergeCoordinator {
    private readonly deps: WorkspaceMergeCoordinatorDeps;
    private isStopped = false;

    /**
     * @param deps Report, updater, emission, banners, paths, logger.
     */
    constructor(deps: WorkspaceMergeCoordinatorDeps) {
        this.deps = deps;
    }

    /**
     * Run in the background; never rejects (failures are logged).
     *
     * @returns Resolves when every item is done and the report is written.
     */
    async run(): Promise<void> {
        try {
            await this.runItems();
        } catch (err) {
            this.deps.log.error(
                `workspace update: coordinator failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    /** Stop before the next item (daemon shutdown); a run in progress continues in the container. */
    stop(): void {
        this.isStopped = true;
    }

    /**
     * Hand every open item to its agent run, then report.
     */
    private async runItems(): Promise<void> {
        const { report, log } = this.deps;
        const items: WorkItem[] = [
            ...report.pendingNotes.map((note) => ({ type: "note" as const, id: note.id })),
            ...report.pending.map((file) => ({ type: "file" as const, file })),
        ];
        if (items.length === 0 || report.gitError !== null) {
            // With a broken history nothing may be resolved (no undo): only tell the user.
            await this.createBanner(renderAutomaticBanner(report));
            return;
        }
        log.info(
            `workspace update: handing ${report.pendingNotes.length} update note(s) and ${report.pending.length} file(s) to one agent run each`,
        );
        const outcomes: ItemOutcome[] = [];
        for (const item of items) {
            if (this.isStopped) {
                log.info(
                    "workspace update: daemon stopping, remaining items wait for the next start",
                );
                return;
            }
            const outcome = await this.runItem(item);
            if (outcome !== null) {
                outcomes.push(outcome);
            }
        }
        await this.finish(outcomes);
    }

    /**
     * Run one item and classify the result by what is still pending afterwards.
     *
     * @param item The note or file.
     * @returns The outcome, or `null` when the item was settled before its turn.
     */
    private async runItem(item: WorkItem): Promise<ItemOutcome | null> {
        const label =
            item.type === "note" ? `note ${item.id}` : (item.file.livePath ?? item.file.path);
        if (!this.isStillPending(item)) {
            return null;
        }
        const event: NewEvent =
            item.type === "note"
                ? {
                      topic: WORKSPACE_APPLY_NOTE_TOPIC,
                      isExactTopic: true,
                      privileged: true,
                      isChat: false,
                      priority: EVENT_PRIORITY.BACKGROUND,
                      idempotencyKey: `workspace-update:note:${item.id}`,
                      prompt: `id: ${item.id}`,
                      payload: { id: item.id },
                  }
                : {
                      topic: WORKSPACE_MERGE_FILE_TOPIC,
                      isExactTopic: true,
                      privileged: true,
                      isChat: false,
                      priority: EVENT_PRIORITY.BACKGROUND,
                      idempotencyKey: `workspace-update:file:${item.file.path}:${this.deps.updater.fingerprint({ pending: [item.file], pendingNotes: [] })}`,
                      prompt: `path: ${item.file.livePath ?? item.file.path}`,
                      payload: { path: item.file.path, kind: item.file.kind },
                  };
        let text: string;
        try {
            const handle = await this.deps.emit(event);
            this.deps.log.info(`workspace update: ${label} → ${event.topic} event ${handle.id}`);
            text = (await handle.settled).trim();
        } catch (err) {
            if (err instanceof DuplicateIdempotencyKeyError) {
                return {
                    label,
                    status: "earlier",
                    text: "already handed to an agent run by an earlier start",
                };
            }
            text = `failed: ${err instanceof Error ? err.message : String(err)}`;
            this.deps.log.warn(`workspace update: ${label} ${text}`);
        }
        return {
            label,
            status: this.isStillPending(item) ? "open" : "decided",
            text: firstLine(text),
        };
    }

    /**
     * Whether an item is still open right now.
     *
     * @param item The note or file.
     * @returns `true` when still pending.
     */
    private isStillPending(item: WorkItem): boolean {
        const status = this.deps.updater.status();
        if (item.type === "note") {
            return status.pendingNotes.some((note) => note.id === item.id);
        }
        return status.pending.some((file) => file.path === item.file.path);
    }

    /**
     * Write the report and the banners.
     *
     * @param outcomes What became of each item.
     */
    private async finish(outcomes: readonly ItemOutcome[]): Promise<void> {
        const automatic = this.deps.report.applied.filter((change) => change.kind !== "seeded");
        const decided = outcomes.filter((outcome) => outcome.status === "decided");
        const open = outcomes.filter((outcome) => outcome.status === "open");
        const earlier = outcomes.filter((outcome) => outcome.status === "earlier");
        if (automatic.length === 0 && decided.length === 0 && open.length === 0) {
            return;
        }
        const reportPath = this.writeReport(
            automatic.map((change) => `${change.kind}: ${change.path}`),
            decided,
            open,
            earlier,
        );
        this.deps.log.info(
            `workspace update: ${decided.length} decided, ${open.length} need the user, ${earlier.length} still open from an earlier start; report ${reportPath}`,
        );
        if (automatic.length > 0 || decided.length > 0) {
            await this.createBanner(
                `Workspace update: ${decided.length + automatic.length} workspace file(s) or note(s) were brought up to the new templates of familiar ${this.deps.version}, keeping the user's customizations (report: ${reportPath}). Tell the user once, briefly, then remove this banner.`,
            );
        }
        if (open.length > 0) {
            await this.createBanner(
                `Workspace update: ${open.length} decision(s) need the user (report: ${reportPath}). Discuss them with the user (skill workspace-update), then remove this banner.`,
            );
        }
    }

    /**
     * Write `files/updates/<date>.md` (with `-2`, `-3`, … when taken) and commit it.
     *
     * @param automatic Lines about automatic changes.
     * @param decided Settled items.
     * @param open Items that need the user.
     * @param earlier Items an earlier start handed over already.
     * @returns The workspace-relative report path.
     */
    private writeReport(
        automatic: readonly string[],
        decided: readonly ItemOutcome[],
        open: readonly ItemOutcome[],
        earlier: readonly ItemOutcome[],
    ): string {
        const date =
            DateTime.now().setZone(this.deps.timezone).toISODate() ??
            new Date().toISOString().slice(0, 10);
        let reportPath = `${REPORT_DIR}/${date}.md`;
        for (
            let counter = 2;
            existsSync(path.join(this.deps.workspaceDir, reportPath));
            counter++
        ) {
            reportPath = `${REPORT_DIR}/${date}-${counter}.md`;
        }
        const list = (lines: readonly string[]) =>
            lines.length === 0 ? "(none)" : lines.map((line) => `- ${line}`).join("\n");
        const sections = [
            `# Workspace update ${date} (familiar ${this.deps.version})`,
            `## Applied automatically\n\nFiles the user never customized.\n\n${list(automatic)}`,
            `## Decided by the assistant\n\n${list(decided.map((outcome) => outcome.text))}`,
            `## Open — needs the user\n\n${list(open.map((outcome) => `${outcome.label}: ${outcome.text}`))}`,
        ];
        if (earlier.length > 0) {
            sections.push(
                `## Still open from an earlier update\n\n${list(earlier.map((outcome) => outcome.label))}`,
            );
        }
        const file = path.join(this.deps.workspaceDir, reportPath);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `${sections.join("\n\n")}\n`);
        if (this.deps.git !== null) {
            this.deps.git
                .commitPaths([reportPath], `workspace update: report ${reportPath}`)
                .catch((err: unknown) =>
                    this.deps.log.warn(
                        `workspace update: could not commit ${reportPath}: ${err instanceof Error ? err.message : String(err)}`,
                    ),
                );
        }
        return reportPath;
    }

    /**
     * Create a banner; logs instead of throwing.
     *
     * @param text Banner text, or `null` for none.
     */
    private async createBanner(text: string | null): Promise<void> {
        if (text === null) {
            return;
        }
        try {
            await this.deps.banners.create({
                text: truncate(text),
                expiresAt: new Date(Date.now() + BANNER_LIFETIME_MS).toISOString(),
            });
        } catch (err) {
            this.deps.log.error(
                `workspace update: could not create banner "${truncate(text).slice(0, 60)}…": ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
}

/**
 * Log the outcome of the daemon-start sync, one self-contained line per fact.
 *
 * @param log Daemon logger.
 * @param report Sync result.
 */
export function logWorkspaceSync(log: Logger, report: SyncReport): void {
    if (report.gitError !== null) {
        log.error(
            `workspace update: workspace git history failed (${report.gitError}); seeded new files only, no template file was overwritten or removed`,
        );
    }
    const counts = new Map<string, number>();
    for (const change of report.applied) {
        counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
    }
    const applied = [...counts].map(([kind, count]) => `${count} ${kind}`).join(", ");
    log.info(
        `workspace update: ${applied === "" ? "no automatic changes" : applied}` +
            `${report.updateCommit === null ? "" : ` (commit ${report.updateCommit})`}; ` +
            `${report.pending.length} file(s) and ${report.pendingNotes.length} update note(s) need a decision`,
    );
}

/**
 * Banner text about automatic changes or a git failure, for a sync that
 * left nothing open.
 *
 * @param report Sync result.
 * @returns The text, or `null` when there is nothing to tell.
 */
export function renderAutomaticBanner(report: SyncReport): string | null {
    if (report.gitError !== null) {
        return `Workspace update held back: the workspace git history failed (${report.gitError}), so no template file was overwritten or removed. Tell the user; it retries on the next daemon start.`;
    }
    const changed = report.applied.filter((change) => change.kind !== "seeded");
    if (changed.length === 0) {
        return null;
    }
    const commit =
        report.updateCommit === null ? "" : ` (workspace git commit ${report.updateCommit})`;
    return (
        `Workspace update: ${changed.length} file(s) the user never customized were updated to the new ` +
        `template version automatically${commit}. Tell the user once, briefly, then remove this banner. Files: ` +
        changed.map((change) => change.path).join(", ")
    );
}

/**
 * First non-empty line of an agent answer (the handlers reply with one line).
 *
 * @param text Answer text.
 * @returns The line, or a placeholder for an empty answer.
 */
function firstLine(text: string): string {
    return (
        text
            .split("\n")
            .find((line) => line.trim() !== "")
            ?.trim() ?? "(no answer)"
    );
}

/**
 * Cut a banner text to the banner limit.
 *
 * @param text Text.
 * @returns The text, ending in `…` when cut.
 */
function truncate(text: string): string {
    return text.length <= BANNER_MAX_TEXT_CHARS
        ? text
        : `${text.slice(0, BANNER_MAX_TEXT_CHARS - 1)}…`;
}
