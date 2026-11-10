import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
    DuplicateIdempotencyKeyError,
    type EmitHandle,
    EVENT_PRIORITY,
    type Logger,
    type NewEvent,
    parseCron,
} from "@getfamiliar/shared";
import { Cron } from "croner";
import { REPAIR_TOPIC, REVIEW_TOPIC } from "./Tools.js";
import { listWikiFiles, type WikiIndex } from "./WikiIndex.js";
import {
    type DateReplacement,
    fixUnambiguousDates,
    type LintProblem,
    lintWikiFile,
} from "./WikiLint.js";

/** One wiki file the linter flagged. */
export interface LintedFile {
    /** Workspace-relative path. */
    readonly path: string;
    /** What is wrong, by line. */
    readonly problems: readonly LintProblem[];
    /** Short hash of the content the problems were found in (part of the repair idempotency key). */
    readonly contentHash: string;
}

/** One wiki file whose `review_at` is due. */
export interface DueReview {
    /** Workspace-relative path. */
    readonly path: string;
    /** The due ISO date. */
    readonly reviewAt: string;
}

/** What happened to the events of one maintenance pass. */
export interface HandOverSummary {
    /** Events emitted now. */
    readonly emitted: number;
    /** Items an earlier pass already handed over (same idempotency key). */
    readonly earlier: number;
    /** Items whose emission failed (logged). */
    readonly failed: number;
}

/** Event emission (`ctx.events.emit`). */
export type EmitEvent = (event: NewEvent) => Promise<EmitHandle>;

/** Commit of workspace files (`ctx.workspaceHistory.commitFiles`). */
export type CommitFiles = (
    relativePaths: readonly string[],
    message: string,
) => Promise<string | null>;

/** The dates the linter can rewrite in one file by itself. */
export interface DateFix {
    /** Workspace-relative path. */
    readonly path: string;
    /** The content the fix was computed on. */
    readonly original: string;
    /** The content with every unambiguous date in ISO form. */
    readonly fixed: string;
    /** Every replacement. */
    readonly replacements: readonly DateReplacement[];
}

/** Result of linting the whole wiki. */
export interface WikiLintResult {
    /** Files with dates the linter rewrites itself. */
    readonly fixes: readonly DateFix[];
    /** Files with problems left for the repair handler, found in the fixed content. */
    readonly flagged: readonly LintedFile[];
}

/** What applying the date fixes did. */
export interface AppliedFixes {
    /** Files rewritten. */
    readonly files: readonly string[];
    /** Dates rewritten in them. */
    readonly dates: number;
    /** Files skipped because they changed after linting (fixed on the next pass). */
    readonly skipped: readonly string[];
    /** Commit of the rewrite, `null` without history. */
    readonly commitId: string | null;
}

/** Everything one lint pass did. */
export interface LintPassSummary {
    readonly applied: AppliedFixes;
    /** Files left for the repair handler. */
    readonly flagged: number;
    readonly handOver: HandOverSummary;
}

/**
 * Lints every markdown file under `wiki/`. Dates with an unambiguous ISO form become fixes the
 * linter applies itself; the remaining problems are reported against the fixed content, which is
 * what the repair handler will see. Reads only.
 *
 * @param workspaceDir - Absolute workspace path.
 * @returns The fixes and the flagged files, both sorted by path.
 */
export async function lintWiki(workspaceDir: string): Promise<WikiLintResult> {
    const fixes: DateFix[] = [];
    const flagged: LintedFile[] = [];
    for (const relativePath of await listWikiFiles(workspaceDir)) {
        const original = await fs.readFile(path.join(workspaceDir, relativePath), "utf8");
        const { content: fixed, replacements } = fixUnambiguousDates(original);
        if (replacements.length > 0) {
            fixes.push({ path: relativePath, original, fixed, replacements });
        }
        const problems = lintWikiFile(fixed);
        if (problems.length > 0) {
            flagged.push({ path: relativePath, problems, contentHash: shortHash(fixed) });
        }
    }
    return { fixes, flagged };
}

/**
 * Writes the date fixes and commits them as one revertible change: a snapshot commit of the
 * affected files first (so earlier, uncommitted edits by agent runs don't end up in the fix
 * commit), then the rewrite. A file that changed since it was linted is skipped and fixed on the
 * next pass.
 *
 * @param workspaceDir - Absolute workspace path.
 * @param fixes - From {@link lintWiki}.
 * @param commit - Workspace history.
 * @returns What was written and committed.
 */
export async function applyDateFixes(
    workspaceDir: string,
    fixes: readonly DateFix[],
    commit: CommitFiles,
): Promise<AppliedFixes> {
    if (fixes.length === 0) {
        return { files: [], dates: 0, skipped: [], commitId: null };
    }
    const paths = fixes.map((fix) => fix.path);
    await commit(paths, "memory lint: snapshot before rewriting dates to ISO");
    const files: string[] = [];
    const skipped: string[] = [];
    let dates = 0;
    for (const fix of fixes) {
        const absolutePath = path.join(workspaceDir, fix.path);
        if ((await fs.readFile(absolutePath, "utf8")) !== fix.original) {
            skipped.push(fix.path);
            continue;
        }
        await fs.writeFile(absolutePath, fix.fixed, "utf8");
        files.push(fix.path);
        dates += fix.replacements.length;
    }
    const commitId = await commit(
        files,
        `memory lint: ${dates} date(s) rewritten to ISO in ${files.length} wiki file(s)\n\n${fixes
            .filter((fix) => files.includes(fix.path))
            .map((fix) => `- ${fix.path}: ${fix.replacements.length}`)
            .join("\n")}`,
    );
    return { files, dates, skipped, commitId };
}

/**
 * One full lint pass, as the nightly job runs it: lint, apply the date fixes, hand every file with
 * problems left to a repair run.
 *
 * @param workspaceDir - Absolute workspace path.
 * @param emit - Event emission.
 * @param commit - Workspace history.
 * @param log - Logger.
 * @returns What happened.
 */
export async function runLintPass(
    workspaceDir: string,
    emit: EmitEvent,
    commit: CommitFiles,
    log: Logger,
): Promise<LintPassSummary> {
    const { fixes, flagged } = await lintWiki(workspaceDir);
    const applied = await applyDateFixes(workspaceDir, fixes, commit);
    // A skipped file's problems were computed on content that is gone; the next pass relints it.
    const toRepair = flagged.filter((file) => !applied.skipped.includes(file.path));
    const handOver = await emitRepairs(toRepair, emit, log);
    return { applied, flagged: toRepair.length, handOver };
}

/**
 * Lists the files due for review today.
 *
 * @param index - The live wiki index.
 * @param timezone - The user's IANA time zone (`core.timezone`).
 * @returns The due files, oldest `review_at` first.
 */
export function listDueReviews(index: WikiIndex, timezone: string): Promise<readonly DueReview[]> {
    return index.listDueReviews(todayIn(timezone));
}

/**
 * Hands every flagged file to one `skills:memory:repair` run. The idempotency key contains the
 * content hash, so the same broken content is never handed over twice — a file the handler could
 * not fix waits until it changes.
 *
 * @param files - The lint result.
 * @param emit - Event emission.
 * @param log - Logger.
 * @returns What happened.
 */
export function emitRepairs(
    files: readonly LintedFile[],
    emit: EmitEvent,
    log: Logger,
): Promise<HandOverSummary> {
    return handOver(
        files.map((file) => ({
            label: file.path,
            event: {
                topic: REPAIR_TOPIC,
                isExactTopic: true,
                priority: EVENT_PRIORITY.BACKGROUND,
                idempotencyKey: `memory-repair:${file.path}:${file.contentHash}`,
                prompt: renderRepairPrompt(file),
                payload: { path: file.path, problems: file.problems },
            },
        })),
        emit,
        log,
    );
}

/**
 * Hands every due file to one `skills:memory:review` run. The idempotency key contains the due
 * date, so a file is reviewed once per `review_at` value: setting a new date schedules the next
 * review, leaving the date as it is doesn't repeat it.
 *
 * @param reviews - The due files.
 * @param emit - Event emission.
 * @param log - Logger.
 * @returns What happened.
 */
export function emitReviews(
    reviews: readonly DueReview[],
    emit: EmitEvent,
    log: Logger,
): Promise<HandOverSummary> {
    return handOver(
        reviews.map((review) => ({
            label: review.path,
            event: {
                topic: REVIEW_TOPIC,
                isExactTopic: true,
                priority: EVENT_PRIORITY.BACKGROUND,
                idempotencyKey: `memory-review:${review.path}:${review.reviewAt}`,
                prompt: `path: ${review.path}\nreview_at: ${review.reviewAt}`,
                payload: { path: review.path, reviewAt: review.reviewAt },
            },
        })),
        emit,
        log,
    );
}

/**
 * Renders the repair run's prompt: the path and one bullet per problem.
 *
 * @param file - The flagged file.
 * @returns The prompt.
 */
export function renderRepairPrompt(file: LintedFile): string {
    const bullets = file.problems.map(
        (problem) => `- line ${problem.lineNo} (${problem.rule}): ${problem.message}`,
    );
    return `path: ${file.path}\n\nProblems found by the linter:\n${bullets.join("\n")}`;
}

/** Dependencies of {@link WikiMaintenance}. */
export interface WikiMaintenanceDeps {
    readonly workspaceDir: string;
    readonly index: WikiIndex;
    readonly emit: EmitEvent;
    readonly commit: CommitFiles;
    readonly log: Logger;
    /** `memory.lintSchedule`. */
    readonly lintSchedule: string;
    /** `memory.reviewSchedule`. */
    readonly reviewSchedule: string;
    /** `core.timezone`: the cron jobs fire and "today" is computed in it. */
    readonly timezone: string;
}

/**
 * The daemon's two maintenance cron jobs: the linter (unambiguous dates rewritten to ISO by itself,
 * every file with problems left → a repair run) and the
 * reviewer (every file with a due `review_at` → a review run). Only detection and scheduling live
 * here; what a repair or a review does is up to the handlers in `skills/memory/`.
 */
export class WikiMaintenance {
    private readonly deps: WikiMaintenanceDeps;
    private readonly jobs: Cron[] = [];

    /**
     * @param deps - Paths, index, emission, logger, schedules.
     */
    constructor(deps: WikiMaintenanceDeps) {
        this.deps = deps;
    }

    /** Registers both cron jobs. An invalid expression is logged and its job skipped. */
    start(): void {
        this.schedule("lint", this.deps.lintSchedule, () => this.runLint());
        this.schedule("review", this.deps.reviewSchedule, () => this.runReviews());
    }

    /** Stops both cron jobs. A pass in progress finishes its emissions. */
    stop(): void {
        for (const job of this.jobs) {
            job.stop();
        }
        this.jobs.length = 0;
    }

    /**
     * One linter pass: lint, then hand every flagged file to a repair run.
     *
     * @returns Resolves when every event is emitted; never rejects (failures are logged).
     */
    async runLint(): Promise<void> {
        const { workspaceDir, emit, commit, log } = this.deps;
        try {
            const { applied, flagged, handOver } = await runLintPass(
                workspaceDir,
                emit,
                commit,
                log,
            );
            log.info(
                `memory: lint rewrote ${applied.dates} date(s) to ISO in ${applied.files.length} file(s)${applied.commitId ? ` (commit ${applied.commitId})` : ""}, skipped ${applied.skipped.length} changed file(s); ${flagged} file(s) need the repair handler — ${handOver.emitted} handed to ${REPAIR_TOPIC}, ${handOver.earlier} unchanged since an earlier hand-over, ${handOver.failed} failed`,
            );
        } catch (err) {
            log.error(
                `memory: lint pass failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    /**
     * One reviewer pass: hand every file with a due `review_at` to a review run.
     *
     * @returns Resolves when every event is emitted; never rejects (failures are logged).
     */
    async runReviews(): Promise<void> {
        const { index, emit, log, timezone } = this.deps;
        try {
            const due = await listDueReviews(index, timezone);
            const summary = await emitReviews(due, emit, log);
            log.info(
                `memory: ${due.length} file(s) due for review — ${summary.emitted} handed to ${REVIEW_TOPIC}, ${summary.earlier} already handed over for the same review_at, ${summary.failed} failed`,
            );
        } catch (err) {
            log.error(
                `memory: review pass failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    /**
     * Registers one cron job.
     *
     * @param name - `lint` or `review`, for the log.
     * @param verbatim - The configured expression.
     * @param pass - The pass to run on each firing.
     */
    private schedule(name: string, verbatim: string, pass: () => Promise<void>): void {
        const { log, timezone } = this.deps;
        const parsed = parseCron(verbatim);
        if (parsed === null) {
            log.warn(
                `memory: invalid ${name} schedule "${verbatim}" (neither friendly nor raw cron) — the ${name} job is disabled`,
            );
            return;
        }
        try {
            this.jobs.push(
                new Cron(parsed.expression, { timezone, protect: true, unref: true }, () => pass()),
            );
            log.info(
                `memory: ${name} job scheduled (${verbatim} → ${parsed.expression}, ${timezone})`,
            );
        } catch (err) {
            log.warn(
                `memory: ${name} schedule "${verbatim}" failed to register (${err instanceof Error ? err.message : String(err)}) — the ${name} job is disabled`,
            );
        }
    }
}

/**
 * Emits the events one after another. A duplicate idempotency key means an earlier pass handed the
 * same item over already; that's counted, not an error. A failed run is only logged — its result
 * doesn't matter to the pass.
 *
 * @param items - Label and event per item.
 * @param emit - Event emission.
 * @param log - Logger.
 * @returns What happened.
 */
async function handOver(
    items: readonly { readonly label: string; readonly event: NewEvent }[],
    emit: EmitEvent,
    log: Logger,
): Promise<HandOverSummary> {
    let emitted = 0;
    let earlier = 0;
    let failed = 0;
    for (const { label, event } of items) {
        try {
            const handle = await emit(event);
            emitted++;
            log.info(`memory: ${label} → ${event.topic} event ${handle.id}`);
            handle.settled.catch((err: unknown) => {
                log.warn(
                    `memory: ${event.topic} event ${handle.id} for ${label} failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            });
        } catch (err) {
            if (err instanceof DuplicateIdempotencyKeyError) {
                earlier++;
                continue;
            }
            failed++;
            log.warn(
                `memory: emitting ${event.topic} for ${label} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
    return { emitted, earlier, failed };
}

/**
 * Today's date in a time zone.
 *
 * @param timezone - IANA zone.
 * @returns ISO `YYYY-MM-DD`.
 */
export function todayIn(timezone: string): string {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

/**
 * First 16 hex characters of the content's SHA-256.
 *
 * @param content - File content.
 * @returns The short hash.
 */
function shortHash(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
