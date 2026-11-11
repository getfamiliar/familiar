import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
    DuplicateIdempotencyKeyError,
    type EmitHandle,
    EVENT_PRIORITY,
    type FileReadSummary,
    type FileReadSummaryOptions,
    type Logger,
    type NewEvent,
    parseCron,
} from "@getfamiliar/shared";
import { Cron } from "croner";
import type { DreamConfig } from "./Config.js";
import {
    DEDUP_SCAN_TOPIC,
    DEDUPLICATE_TOPIC,
    DREAM_TOPIC,
    REPAIR_TOPIC,
    REVIEW_TOPIC,
    SPLIT_TOPIC,
} from "./Tools.js";
import {
    DedupPairStore,
    groupByTopFolder,
    type HandledPair,
    pairKey,
    pairsOf,
    parseScanReply,
    renderDeduplicatePrompt,
    renderScanPrompt,
} from "./WikiDedup.js";
import {
    type DreamReadStats,
    type DreamSelection,
    DreamStore,
    renderDreamPrompt,
    selectDreams,
} from "./WikiDream.js";
import { listWikiFiles, WIKI_FOLDER, type WikiIndex } from "./WikiIndex.js";
import {
    type DateReplacement,
    fixUnambiguousDates,
    type LintProblem,
    lintWikiFile,
} from "./WikiLint.js";
import { applyHarnessSplit, fileBytes, findOversizedFiles } from "./WikiSplit.js";

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

/** Commit of everything below a workspace folder (`ctx.workspaceHistory.commitDirectory`). */
export type CommitDirectory = (relativeDir: string, message: string) => Promise<string | null>;

/** How a handler run that a pass waited for ended. */
export type HandlerRunResult =
    | { readonly status: "done"; readonly text: string; readonly eventId: string }
    /** `eventId` is missing when the event could not even be emitted. */
    | { readonly status: "failed"; readonly message: string; readonly eventId?: string }
    /** An earlier pass handed the same item over already (same idempotency key). */
    | { readonly status: "earlier" };

/** What the split pass did with one oversized file. */
export interface SplitOutcome {
    readonly path: string;
    /** Size when the pass found it. */
    readonly bytesBefore: number;
    /** Size after the run (and the harness split), `undefined` when the file is gone. */
    readonly bytesAfter: number | undefined;
    /** The split run, `undefined` when the file was no longer too big when its turn came. */
    readonly run: HandlerRunResult | undefined;
    /** Path of the second half when the harness had to cut the file. */
    readonly harnessSecondPath: string | undefined;
}

/** Everything one split pass did. */
export interface SplitPassSummary {
    readonly outcomes: readonly SplitOutcome[];
    /** Commit before the runs, `null` without history or changes. */
    readonly snapshotCommitId: string | null;
    /** Commit after the runs. */
    readonly finalCommitId: string | null;
}

/** What the dedup pass did with one candidate group. */
export interface DedupOutcome {
    /** The group as the scan reported it. */
    readonly group: readonly string[];
    /** The deduplicate run, `undefined` when fewer than two files were left when its turn came. */
    readonly run: HandlerRunResult | undefined;
    /** Pairs stored as handled after the run. */
    readonly recordedPairs: number;
}

/** Everything one dedup pass did. */
export interface DedupPassSummary {
    /** Stored pairs forgotten because a file is gone or changed. */
    readonly prunedPairs: number;
    /** Folders scanned, with the scan run's result. */
    readonly scans: readonly { readonly folder: string; readonly run: HandlerRunResult }[];
    /** Groups the scans reported (after parsing). */
    readonly reportedGroups: number;
    /** Groups skipped because every pair of them was handled before. */
    readonly knownGroups: number;
    readonly outcomes: readonly DedupOutcome[];
    readonly snapshotCommitId: string | null;
    readonly finalCommitId: string | null;
}

/** Dependencies of the split and dedup passes. */
export interface PassDeps {
    readonly workspaceDir: string;
    readonly index: WikiIndex;
    readonly emit: EmitEvent;
    readonly commitDirectory: CommitDirectory;
    readonly log: Logger;
    /** `memory.maxFileBytes`. */
    readonly maxFileBytes: number;
    /** `core.timezone`, for the date in idempotency keys. */
    readonly timezone: string;
    /** Checked between items; `true` ends the pass early (plugin stopping). */
    readonly shouldStop: () => boolean;
    /**
     * Most split / deduplicate / dream runs one pass starts (the CLI's `-n`); `undefined` = no limit.
     * Dedup scans don't count.
     */
    readonly maxRuns?: number;
}

/** Reads of workspace files (`ctx.workspaceReads.summarize`). */
export type SummarizeReads = (
    options: FileReadSummaryOptions,
) => Promise<readonly FileReadSummary[]>;

/** Dependencies of the dream pass. */
export interface DreamPassDeps extends PassDeps {
    /** `memory.dream.*`. */
    readonly dream: DreamConfig;
    readonly summarizeReads: SummarizeReads;
    /** `core.fileReadRetentionDays`: the window the read stats cover. */
    readonly readWindowDays: number;
    /** Uniform random in [0, 1); `Math.random` unless a test injects one. */
    readonly random?: () => number;
    /** The current time; `new Date()` unless a test injects one. */
    readonly now?: () => Date;
}

/** Handler runs whose reads don't make a file "hot": the memory maintenance itself. */
const MAINTENANCE_HANDLER_PREFIX = "skills/memory/";

/** What the next dream pass would pick, and what is locked. */
export interface DreamPlan {
    readonly selections: readonly DreamSelection[];
    /** Paths dreamed within the lock period. */
    readonly locked: readonly string[];
}

/** What the dream pass did with one file. */
export interface DreamOutcome {
    readonly selection: DreamSelection;
    /** Size before the run, `undefined` when the file was gone when its turn came. */
    readonly bytesBefore: number | undefined;
    /** Size after the run, `undefined` when the file is gone. */
    readonly bytesAfter: number | undefined;
    readonly run: HandlerRunResult | undefined;
}

/** Everything one dream pass did. */
export interface DreamPassSummary {
    readonly outcomes: readonly DreamOutcome[];
    readonly snapshotCommitId: string | null;
    readonly finalCommitId: string | null;
}

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

/**
 * One split pass, as the daily job runs it: every wiki file above `memory.maxFileBytes` goes to
 * one `skills:memory:split` run, one after the other; a file still too big afterwards is cut in
 * half by the harness. The whole `wiki/` folder is committed once before and once after.
 *
 * @param deps - Paths, emission, history, limits.
 * @returns What happened.
 */
export async function runSplitPass(deps: PassDeps): Promise<SplitPassSummary> {
    const { workspaceDir, emit, commitDirectory, log, maxFileBytes } = deps;
    const oversized = await findOversizedFiles(workspaceDir, maxFileBytes);
    if (oversized.length === 0) {
        return { outcomes: [], snapshotCommitId: null, finalCommitId: null };
    }
    const snapshotCommitId = await commitDirectory(
        WIKI_FOLDER,
        `memory split: snapshot before handling ${oversized.length} file(s) over ${maxFileBytes} bytes`,
    );
    const outcomes: SplitOutcome[] = [];
    let startedRuns = 0;
    for (const file of oversized) {
        if (deps.shouldStop()) {
            log.info("memory: split pass stopped early — the plugin is stopping");
            break;
        }
        if (deps.maxRuns !== undefined && startedRuns >= deps.maxRuns) {
            log.info(`memory: split pass stopped after ${startedRuns} run(s) — limit reached`);
            break;
        }
        const bytesNow = await fileBytes(workspaceDir, file.path);
        if (bytesNow === undefined || bytesNow <= maxFileBytes) {
            outcomes.push({
                path: file.path,
                bytesBefore: file.bytes,
                bytesAfter: bytesNow,
                run: undefined,
                harnessSecondPath: undefined,
            });
            continue;
        }
        const content = await fs.readFile(path.join(workspaceDir, file.path), "utf8");
        startedRuns++;
        const run = await runAndWait(
            {
                topic: SPLIT_TOPIC,
                isExactTopic: true,
                priority: EVENT_PRIORITY.BACKGROUND,
                idempotencyKey: `memory-split:${file.path}:${shortHash(content)}`,
                prompt: `path: ${file.path}\nsize: ${bytesNow} bytes\nlimit: ${maxFileBytes} bytes`,
                payload: { path: file.path, bytes: bytesNow, maxFileBytes },
            },
            file.path,
            emit,
            log,
        );
        let bytesAfter = await fileBytes(workspaceDir, file.path);
        let harnessSecondPath: string | undefined;
        if (bytesAfter !== undefined && bytesAfter > maxFileBytes) {
            const split = await applyHarnessSplit(workspaceDir, file.path);
            if (split === undefined) {
                log.warn(
                    `memory: ${file.path} is still ${bytesAfter} bytes (limit ${maxFileBytes}) and has no line to cut at — left as it is`,
                );
            } else {
                harnessSecondPath = split.secondPath;
                bytesAfter = await fileBytes(workspaceDir, file.path);
                log.info(
                    `memory: ${file.path} was still over ${maxFileBytes} bytes after the split run — the harness cut it in half, second half ${split.secondPath}`,
                );
            }
        }
        outcomes.push({
            path: file.path,
            bytesBefore: file.bytes,
            bytesAfter,
            run,
            harnessSecondPath,
        });
    }
    const finalCommitId = await commitDirectory(WIKI_FOLDER, renderSplitCommitMessage(outcomes));
    return { outcomes, snapshotCommitId, finalCommitId };
}

/**
 * One dedup pass, as the weekly job runs it: forget stale handled pairs, hand every top-level
 * wiki folder's file list to a `skills:memory:dedup-scan` run, then every reported group with at
 * least one pair not handled before to a `skills:memory:deduplicate` run — all one after the
 * other. The pairs of a group whose run succeeded are stored with the files' sizes after the run.
 * The whole `wiki/` folder is committed before and after the deduplicate runs.
 *
 * @param deps - Paths, index, emission, history.
 * @returns What happened.
 */
export async function runDedupPass(deps: PassDeps): Promise<DedupPassSummary> {
    const { workspaceDir, index, emit, commitDirectory, log } = deps;
    const store = new DedupPairStore(index);
    const paths = await listWikiFiles(workspaceDir);
    const prunedPairs = await store.prune(await sizesOf(workspaceDir, paths));
    const existing = new Set(paths);
    const scans: { folder: string; run: HandlerRunResult }[] = [];
    const reported: (readonly string[])[] = [];
    for (const [folder, folderPaths] of groupByTopFolder(paths)) {
        if (folderPaths.length < 2) {
            continue;
        }
        if (deps.shouldStop()) {
            log.info("memory: dedup pass stopped early — the plugin is stopping");
            break;
        }
        const entries = (await index.listFolderEntries(`${WIKI_FOLDER}/${folder}`)).filter(
            (entry) => existing.has(entry.path),
        );
        const run = await runAndWait(
            {
                topic: DEDUP_SCAN_TOPIC,
                isExactTopic: true,
                priority: EVENT_PRIORITY.BACKGROUND,
                idempotencyKey: `memory-dedup-scan:${folder}:${new Date().toISOString()}`,
                prompt: renderScanPrompt(folder, entries),
                payload: { folder: `${WIKI_FOLDER}/${folder}`, files: entries.length },
            },
            `${WIKI_FOLDER}/${folder}`,
            emit,
            log,
        );
        scans.push({ folder, run });
        if (run.status !== "done") {
            continue;
        }
        const parsed = parseScanReply(run.text, existing);
        for (const warning of parsed.warnings) {
            log.warn(`memory: dedup scan of ${WIKI_FOLDER}/${folder}: ${warning}`);
        }
        log.info(
            `memory: dedup scan of ${WIKI_FOLDER}/${folder} (${entries.length} files) reported ${parsed.groups.length} candidate group(s)`,
        );
        reported.push(...parsed.groups);
    }
    const known = await store.listKeys();
    const fresh = reported.filter((group) =>
        pairsOf(group).some(([pathA, pathB]) => !known.has(pairKey(pathA, pathB))),
    );
    const base = {
        prunedPairs,
        scans,
        reportedGroups: reported.length,
        knownGroups: reported.length - fresh.length,
    };
    if (fresh.length === 0) {
        return { ...base, outcomes: [], snapshotCommitId: null, finalCommitId: null };
    }
    const snapshotCommitId = await commitDirectory(
        WIKI_FOLDER,
        `memory dedup: snapshot before handling ${fresh.length} candidate group(s)`,
    );
    const outcomes: DedupOutcome[] = [];
    let startedRuns = 0;
    for (const group of fresh) {
        if (deps.shouldStop()) {
            log.info("memory: dedup pass stopped early — the plugin is stopping");
            break;
        }
        if (deps.maxRuns !== undefined && startedRuns >= deps.maxRuns) {
            log.info(`memory: dedup pass stopped after ${startedRuns} run(s) — limit reached`);
            break;
        }
        const contents = new Map<string, string>();
        for (const groupPath of group) {
            const content = await readIfExists(workspaceDir, groupPath);
            if (content !== undefined) {
                contents.set(groupPath, content);
            }
        }
        if (contents.size < 2) {
            outcomes.push({ group, run: undefined, recordedPairs: 0 });
            continue;
        }
        const fingerprint = [...contents.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([groupPath, content]) => `${groupPath}:${shortHash(content)}`)
            .join("\n");
        startedRuns++;
        const run = await runAndWait(
            {
                topic: DEDUPLICATE_TOPIC,
                isExactTopic: true,
                priority: EVENT_PRIORITY.BACKGROUND,
                idempotencyKey: `memory-deduplicate:${todayIn(deps.timezone)}:${shortHash(fingerprint)}`,
                prompt: renderDeduplicatePrompt(contents),
                payload: { paths: [...contents.keys()] },
            },
            [...contents.keys()].join(", "),
            emit,
            log,
        );
        let recordedPairs = 0;
        if (run.status === "done") {
            const handled: HandledPair[] = [];
            for (const [pathA, pathB] of pairsOf([...contents.keys()])) {
                const sizeA = await fileBytes(workspaceDir, pathA);
                const sizeB = await fileBytes(workspaceDir, pathB);
                // A pair with a file merged away is settled for good; only pairs of files that
                // both survived are remembered, so they aren't looked at again until one changes.
                if (sizeA !== undefined && sizeB !== undefined) {
                    handled.push({ pathA, pathB, sizeA, sizeB });
                }
            }
            await store.record(handled);
            recordedPairs = handled.length;
        }
        outcomes.push({ group, run, recordedPairs });
    }
    const finalCommitId = await commitDirectory(WIKI_FOLDER, renderDedupCommitMessage(outcomes));
    return { ...base, outcomes, snapshotCommitId, finalCommitId };
}

/**
 * Works out what the next dream pass picks: forgets dreams older than the lock
 * period, then selects among the indexed files on disk that are not locked.
 *
 * @param deps - Index, reads, config.
 * @returns The selections and the locked paths.
 */
export async function planDreams(deps: DreamPassDeps): Promise<DreamPlan> {
    const now = (deps.now ?? (() => new Date()))();
    const lockStart = new Date(now.getTime() - deps.dream.lockDays * ONE_DAY_MS);
    const store = new DreamStore(deps.index);
    await store.pruneBefore(lockStart);
    const onDisk = new Set(await listWikiFiles(deps.workspaceDir));
    const candidates = (await store.listCandidates()).filter((candidate) =>
        onDisk.has(candidate.path),
    );
    const locked = [
        ...new Set((await store.listDreamsSince(lockStart)).map((dream) => dream.path)),
    ];
    const summaries = await deps.summarizeReads({
        pathPrefix: `${WIKI_FOLDER}/`,
        since: new Date(now.getTime() - deps.readWindowDays * ONE_DAY_MS),
        excludeHandlerPrefixes: [MAINTENANCE_HANDLER_PREFIX],
    });
    const reads = new Map<string, DreamReadStats>(
        summaries.map((summary) => [summary.path, summary]),
    );
    const selections = selectDreams({
        candidates,
        reads,
        locked: new Set(locked),
        counts: deps.dream.counts,
        lastPassAt: (await store.lastDreamedAt()) ?? lockStart,
        readWindowDays: deps.readWindowDays,
        random: deps.random ?? Math.random,
    });
    return { selections, locked: locked.sort() };
}

/**
 * One dream pass, as the daily job runs it: every selected file goes to one
 * `skills:memory:dream` run, one after the other. A successful run is recorded
 * (the file is locked for `memory.dream.lockDays`, its `dreamed_at` /
 * `dreamed_size` set); a failed one is not, so the file can come up again.
 * `wiki/` is committed before and after, the final commit listing every file
 * with its reason, event id and the run's summary.
 *
 * @param deps - Paths, index, emission, history, reads, config.
 * @returns What happened.
 */
export async function runDreamPass(deps: DreamPassDeps): Promise<DreamPassSummary> {
    const { workspaceDir, index, emit, commitDirectory, log } = deps;
    const { selections } = await planDreams(deps);
    if (selections.length === 0) {
        return { outcomes: [], snapshotCommitId: null, finalCommitId: null };
    }
    const snapshotCommitId = await commitDirectory(
        WIKI_FOLDER,
        `memory dream: snapshot before dreaming ${selections.length} file(s)\n\n${selections
            .map((selection) => `- ${selection.path} (${selection.criterion}: ${selection.reason})`)
            .join("\n")}`,
    );
    const store = new DreamStore(index);
    const outcomes: DreamOutcome[] = [];
    let startedRuns = 0;
    for (const selection of selections) {
        if (deps.shouldStop()) {
            log.info("memory: dream pass stopped early — the plugin is stopping");
            break;
        }
        if (deps.maxRuns !== undefined && startedRuns >= deps.maxRuns) {
            log.info(`memory: dream pass stopped after ${startedRuns} run(s) — limit reached`);
            break;
        }
        const bytesBefore = await fileBytes(workspaceDir, selection.path);
        if (bytesBefore === undefined) {
            outcomes.push({ selection, bytesBefore, bytesAfter: undefined, run: undefined });
            continue;
        }
        startedRuns++;
        const run = await runAndWait(
            {
                topic: DREAM_TOPIC,
                isExactTopic: true,
                priority: EVENT_PRIORITY.BACKGROUND,
                idempotencyKey: `memory-dream:${selection.path}:${todayIn(deps.timezone)}`,
                prompt: renderDreamPrompt(selection, bytesBefore),
                payload: { path: selection.path, criterion: selection.criterion },
            },
            selection.path,
            emit,
            log,
        );
        const bytesAfter = await fileBytes(workspaceDir, selection.path);
        if (run.status === "done") {
            await store.record({
                path: selection.path,
                eventId: run.eventId,
                criterion: selection.criterion,
                summary: run.text.trim(),
                sizeAfter: bytesAfter,
            });
        }
        outcomes.push({ selection, bytesBefore, bytesAfter, run });
    }
    const finalCommitId = await commitDirectory(WIKI_FOLDER, renderDreamCommitMessage(outcomes));
    return { outcomes, snapshotCommitId, finalCommitId };
}

/**
 * Renders the commit message after a dream pass: one line per file with its
 * reason, the event id and the first line of the run's summary.
 *
 * @param outcomes - Per file.
 * @returns The message.
 */
function renderDreamCommitMessage(outcomes: readonly DreamOutcome[]): string {
    const dreamed = outcomes.filter((outcome) => outcome.run?.status === "done").length;
    const lines = outcomes.map((outcome) => {
        const { selection, run } = outcome;
        const event =
            run !== undefined && "eventId" in run && run.eventId ? ` — event ${run.eventId}` : "";
        return `- ${selection.path} (${selection.criterion}: ${selection.reason})${event}: ${describeRun(run)}`;
    });
    return `memory dream: ${dreamed} of ${outcomes.length} file(s) dreamed\n\n${lines.join("\n")}`;
}

/** Milliseconds per day. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Emits one event and waits until its run settled. Never rejects: a failed run and a failed
 * emission come back as `failed`, a repeated idempotency key as `earlier`.
 *
 * @param event - The event.
 * @param label - What the run is about, for the log.
 * @param emit - Event emission.
 * @param log - Logger.
 * @returns How the run ended.
 */
async function runAndWait(
    event: NewEvent,
    label: string,
    emit: EmitEvent,
    log: Logger,
): Promise<HandlerRunResult> {
    let handle: EmitHandle;
    try {
        handle = await emit(event);
    } catch (err) {
        if (err instanceof DuplicateIdempotencyKeyError) {
            log.info(
                `memory: ${label} was handed to ${event.topic} before with the same content — skipped`,
            );
            return { status: "earlier" };
        }
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`memory: emitting ${event.topic} for ${label} failed: ${message}`);
        return { status: "failed", message };
    }
    log.info(`memory: ${label} → ${event.topic} event ${handle.id}, waiting for it`);
    try {
        const text = await handle.settled;
        log.info(`memory: ${event.topic} event ${handle.id} for ${label} done: ${firstLine(text)}`);
        return { status: "done", text, eventId: handle.id };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`memory: ${event.topic} event ${handle.id} for ${label} failed: ${message}`);
        return { status: "failed", message, eventId: handle.id };
    }
}

/**
 * Renders the commit message after a split pass.
 *
 * @param outcomes - Per file.
 * @returns The message.
 */
function renderSplitCommitMessage(outcomes: readonly SplitOutcome[]): string {
    const cut = outcomes.filter((outcome) => outcome.harnessSecondPath !== undefined).length;
    const lines = outcomes.map((outcome) => {
        const after = outcome.bytesAfter === undefined ? "gone" : `${outcome.bytesAfter} bytes`;
        const harness = outcome.harnessSecondPath
            ? `, cut by the harness → ${outcome.harnessSecondPath}`
            : "";
        return `- ${outcome.path}: ${outcome.bytesBefore} → ${after} (${describeRun(outcome.run)}${harness})`;
    });
    return `memory split: ${outcomes.length} oversized file(s) handled, ${cut} cut by the harness\n\n${lines.join("\n")}`;
}

/**
 * Renders the commit message after a dedup pass.
 *
 * @param outcomes - Per group.
 * @returns The message.
 */
function renderDedupCommitMessage(outcomes: readonly DedupOutcome[]): string {
    const lines = outcomes.map(
        (outcome) => `- ${outcome.group.join(", ")} (${describeRun(outcome.run)})`,
    );
    return `memory dedup: ${outcomes.length} candidate group(s) handled\n\n${lines.join("\n")}`;
}

/**
 * Describes how a run ended, in one short phrase.
 *
 * @param run - The run result, `undefined` when there was no run.
 * @returns The phrase.
 */
export function describeRun(run: HandlerRunResult | undefined): string {
    if (run === undefined) {
        return "no run needed";
    }
    if (run.status === "done") {
        return firstLine(run.text) || "done";
    }
    return run.status === "earlier" ? "handed over earlier" : `failed: ${firstLine(run.message)}`;
}

/**
 * The first non-blank line of a text, at most 200 characters.
 *
 * @param text - Text.
 * @returns The line.
 */
function firstLine(text: string): string {
    const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== "") ?? "";
    return line.length > 200 ? `${line.slice(0, 199)}…` : line.trim();
}

/**
 * Sizes of files on disk.
 *
 * @param workspaceDir - Absolute workspace path.
 * @param paths - Workspace-relative paths.
 * @returns Path → bytes, for the files that exist.
 */
async function sizesOf(
    workspaceDir: string,
    paths: readonly string[],
): Promise<ReadonlyMap<string, number>> {
    const sizes = new Map<string, number>();
    for (const relativePath of paths) {
        const bytes = await fileBytes(workspaceDir, relativePath);
        if (bytes !== undefined) {
            sizes.set(relativePath, bytes);
        }
    }
    return sizes;
}

/**
 * Reads a file, tolerating that it is gone.
 *
 * @param workspaceDir - Absolute workspace path.
 * @param relativePath - Workspace-relative path.
 * @returns The content, or `undefined` when the file doesn't exist.
 */
async function readIfExists(
    workspaceDir: string,
    relativePath: string,
): Promise<string | undefined> {
    try {
        return await fs.readFile(path.join(workspaceDir, relativePath), "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw err;
    }
}

/** Dependencies of {@link WikiMaintenance}. */
export interface WikiMaintenanceDeps {
    readonly workspaceDir: string;
    readonly index: WikiIndex;
    readonly emit: EmitEvent;
    readonly commit: CommitFiles;
    readonly commitDirectory: CommitDirectory;
    readonly log: Logger;
    /** `memory.lintSchedule`. */
    readonly lintSchedule: string;
    /** `memory.reviewSchedule`. */
    readonly reviewSchedule: string;
    /** `memory.maxFileBytes`. */
    readonly maxFileBytes: number;
    /** `memory.splitSchedule`. */
    readonly splitSchedule: string;
    /** `memory.dedupSchedule`. */
    readonly dedupSchedule: string;
    /** `memory.dream.*`. */
    readonly dream: DreamConfig;
    /** `ctx.workspaceReads.summarize`. */
    readonly summarizeReads: SummarizeReads;
    /** `core.fileReadRetentionDays`. */
    readonly readWindowDays: number;
    /** `core.timezone`: the cron jobs fire and "today" is computed in it. */
    readonly timezone: string;
}

/**
 * The daemon's maintenance cron jobs: the linter (unambiguous dates rewritten to ISO by itself,
 * every file with problems left → a repair run), the reviewer (every file with a due `review_at` →
 * a review run), the splitter (every oversized file → a split run) and the deduplicator (folder
 * scans → deduplicate runs). Only detection, scheduling and the harness fallbacks live here; what
 * happens to a file is up to the handlers in `skills/memory/`. Split and dedup passes never run
 * at the same time.
 */
export class WikiMaintenance {
    private readonly deps: WikiMaintenanceDeps;
    private readonly jobs: Cron[] = [];
    /** Serializes the split and dedup passes. */
    private passChain: Promise<void> = Promise.resolve();
    private isStopped = false;

    /**
     * @param deps - Paths, index, emission, logger, schedules.
     */
    constructor(deps: WikiMaintenanceDeps) {
        this.deps = deps;
    }

    /** Registers the cron jobs. An invalid expression is logged and its job skipped. */
    start(): void {
        this.schedule("lint", this.deps.lintSchedule, () => this.runLint());
        this.schedule("review", this.deps.reviewSchedule, () => this.runReviews());
        this.schedule("split", this.deps.splitSchedule, () =>
            this.exclusive(() => this.runSplit()),
        );
        this.schedule("dedup", this.deps.dedupSchedule, () =>
            this.exclusive(() => this.runDedup()),
        );
        this.schedule("dream", this.deps.dream.schedule, () =>
            this.exclusive(() => this.runDream()),
        );
    }

    /**
     * Stops the cron jobs. A lint or review pass in progress finishes its emissions; a split or
     * dedup pass ends after the run it is waiting for.
     */
    stop(): void {
        this.isStopped = true;
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
     * One split pass.
     *
     * @returns Resolves when the pass is over; never rejects (failures are logged).
     */
    async runSplit(): Promise<void> {
        const { log, maxFileBytes } = this.deps;
        try {
            const { outcomes, finalCommitId } = await runSplitPass(this.passDeps());
            const cut = outcomes.filter((outcome) => outcome.harnessSecondPath !== undefined);
            log.info(
                `memory: split pass handled ${outcomes.length} file(s) over ${maxFileBytes} bytes, ${cut.length} cut by the harness${finalCommitId ? ` (commit ${finalCommitId})` : ""}`,
            );
        } catch (err) {
            log.error(
                `memory: split pass failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    /**
     * One dedup pass.
     *
     * @returns Resolves when the pass is over; never rejects (failures are logged).
     */
    async runDedup(): Promise<void> {
        const { log } = this.deps;
        try {
            const summary = await runDedupPass(this.passDeps());
            log.info(
                `memory: dedup pass scanned ${summary.scans.length} folder(s), ${summary.reportedGroups} candidate group(s) reported, ${summary.knownGroups} handled before, ${summary.outcomes.length} handed to ${DEDUPLICATE_TOPIC}; ${summary.prunedPairs} stale pair(s) forgotten${summary.finalCommitId ? ` (commit ${summary.finalCommitId})` : ""}`,
            );
        } catch (err) {
            log.error(
                `memory: dedup pass failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    /**
     * One dream pass.
     *
     * @returns Resolves when the pass is over; never rejects (failures are logged).
     */
    async runDream(): Promise<void> {
        const { log, dream, summarizeReads, readWindowDays } = this.deps;
        try {
            const summary = await runDreamPass({
                ...this.passDeps(),
                dream,
                summarizeReads,
                readWindowDays,
            });
            const dreamed = summary.outcomes.filter((outcome) => outcome.run?.status === "done");
            log.info(
                `memory: dream pass dreamed ${dreamed.length} of ${summary.outcomes.length} selected file(s)${summary.finalCommitId ? ` (commit ${summary.finalCommitId})` : ""}`,
            );
        } catch (err) {
            log.error(
                `memory: dream pass failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    /**
     * The pass dependencies, stopping when this instance is stopped.
     *
     * @returns The deps.
     */
    private passDeps(): PassDeps {
        const { workspaceDir, index, emit, commitDirectory, log, maxFileBytes, timezone } =
            this.deps;
        return {
            workspaceDir,
            index,
            emit,
            commitDirectory,
            log,
            maxFileBytes,
            timezone,
            shouldStop: () => this.isStopped,
        };
    }

    /**
     * Runs a pass after every split or dedup pass queued before it.
     *
     * @param pass - The pass.
     * @returns Resolves when it is over.
     */
    private exclusive(pass: () => Promise<void>): Promise<void> {
        const next = this.passChain.then(pass);
        this.passChain = next.catch(() => undefined);
        return next;
    }

    /**
     * Registers one cron job.
     *
     * @param name - `lint`, `review`, `split`, `dedup` or `dream`, for the log.
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
