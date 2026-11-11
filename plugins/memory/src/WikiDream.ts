import type { WikiIndex } from "./WikiIndex.js";

/** Why a file was picked for a dream, in the order the criteria are filled. */
export const DREAM_CRITERIA = ["changed", "hot", "cold", "oldest", "random"] as const;

/** One selection criterion. */
export type DreamCriterion = (typeof DREAM_CRITERIA)[number];

/** How many files each criterion picks per pass (`memory.dream.<criterion>`). */
export type DreamCounts = Readonly<Record<DreamCriterion, number>>;

/** What the selection knows about one indexed wiki file. */
export type DreamCandidate = {
    readonly path: string;
    readonly sizeBytes: number;
    readonly modifiedAt: Date;
    /** When the index first saw the path; `null` for files indexed before dreaming existed. */
    readonly firstSeenAt: Date | null;
    readonly dreamedAt: Date | null;
    /** Size right after the last dream. */
    readonly dreamedSize: number | null;
};

/** How often a file was read (from `ctx.workspaceReads.summarize`). */
export interface DreamReadStats {
    readonly readingRuns: number;
    readonly lastReadAt: Date;
}

/** One file picked for a dream. */
export interface DreamSelection {
    readonly path: string;
    readonly criterion: DreamCriterion;
    /** One line for the prompt and the commit, e.g. `+4210 bytes since the last dream on 2026-11-02`. */
    readonly reason: string;
}

/** Everything {@link selectDreams} decides on. */
export interface DreamSelectionInput {
    /** Indexed files that exist on disk. */
    readonly candidates: readonly DreamCandidate[];
    /** Path → reads within the read window (maintenance runs left out). */
    readonly reads: ReadonlyMap<string, DreamReadStats>;
    /** Paths dreamed within the lock period. */
    readonly locked: ReadonlySet<string>;
    readonly counts: DreamCounts;
    /** Start of "since the last dreaming": the latest dream, or now − lock period without one. */
    readonly lastPassAt: Date;
    /** Days the read stats cover, for the reason text. */
    readonly readWindowDays: number;
    /** Uniform random number in [0, 1), injectable for tests. */
    readonly random: () => number;
}

/**
 * Picks the files of one dream pass. The criteria are filled in order —
 * changed, hot, cold, oldest, random — and a file picked once is gone for the
 * rest, so no file is dreamed twice in a pass. Locked files are never picked.
 *
 * - **changed**: modified since its last dream (or, never dreamed, since the
 *   last pass). New files first (oldest first), then by growth since the last
 *   dream — a never-dreamed file counts with its whole size.
 * - **hot**: read by the most runs, then most recently.
 * - **cold**: longest neither modified nor read.
 * - **oldest**: never dreamed first (longest unmodified first), then longest since its dream.
 * - **random**: uniform over the rest.
 *
 * @param input - Candidates, reads, locks, counts.
 * @returns The selections, in criterion order.
 */
export function selectDreams(input: DreamSelectionInput): readonly DreamSelection[] {
    const { counts, reads, lastPassAt } = input;
    let pool = input.candidates.filter((candidate) => !input.locked.has(candidate.path));
    const selections: DreamSelection[] = [];
    const take = (
        criterion: DreamCriterion,
        ordered: readonly DreamCandidate[],
        reason: (candidate: DreamCandidate) => string,
    ): void => {
        const picked = ordered.slice(0, Math.max(0, counts[criterion]));
        for (const candidate of picked) {
            selections.push({ path: candidate.path, criterion, reason: reason(candidate) });
        }
        const pickedPaths = new Set(picked.map((candidate) => candidate.path));
        pool = pool.filter((candidate) => !pickedPaths.has(candidate.path));
    };

    const isNew = (candidate: DreamCandidate): boolean =>
        candidate.dreamedAt === null &&
        candidate.firstSeenAt !== null &&
        candidate.firstSeenAt > lastPassAt;
    const growth = (candidate: DreamCandidate): number =>
        candidate.sizeBytes - (candidate.dreamedSize ?? 0);
    take(
        "changed",
        pool
            .filter((candidate) => candidate.modifiedAt > (candidate.dreamedAt ?? lastPassAt))
            .sort((a, b) => {
                if (isNew(a) !== isNew(b)) {
                    return isNew(a) ? -1 : 1;
                }
                if (isNew(a)) {
                    return (
                        compareDates(a.firstSeenAt, b.firstSeenAt) || a.path.localeCompare(b.path)
                    );
                }
                return growth(b) - growth(a) || a.path.localeCompare(b.path);
            }),
        (candidate) => {
            if (isNew(candidate)) {
                return "new file";
            }
            if (candidate.dreamedAt === null) {
                return `modified on ${isoDate(candidate.modifiedAt)}, never dreamed`;
            }
            const change = growth(candidate);
            return `${change >= 0 ? "+" : ""}${change} bytes since the last dream on ${isoDate(candidate.dreamedAt)}`;
        },
    );

    take(
        "hot",
        pool
            .filter((candidate) => (reads.get(candidate.path)?.readingRuns ?? 0) > 0)
            .sort((a, b) => {
                const readsA = reads.get(a.path) as DreamReadStats;
                const readsB = reads.get(b.path) as DreamReadStats;
                return (
                    readsB.readingRuns - readsA.readingRuns ||
                    readsB.lastReadAt.getTime() - readsA.lastReadAt.getTime() ||
                    a.path.localeCompare(b.path)
                );
            }),
        (candidate) =>
            `read by ${reads.get(candidate.path)?.readingRuns ?? 0} run(s) in the last ${input.readWindowDays} days`,
    );

    const lastTouched = (candidate: DreamCandidate): Date => {
        const lastRead = reads.get(candidate.path)?.lastReadAt;
        return lastRead !== undefined && lastRead > candidate.modifiedAt
            ? lastRead
            : candidate.modifiedAt;
    };
    take(
        "cold",
        [...pool].sort(
            (a, b) =>
                lastTouched(a).getTime() - lastTouched(b).getTime() || a.path.localeCompare(b.path),
        ),
        (candidate) => `not changed or read since ${isoDate(lastTouched(candidate))}`,
    );

    take(
        "oldest",
        [...pool].sort((a, b) => {
            if ((a.dreamedAt === null) !== (b.dreamedAt === null)) {
                return a.dreamedAt === null ? -1 : 1;
            }
            if (a.dreamedAt === null) {
                return (
                    a.modifiedAt.getTime() - b.modifiedAt.getTime() || a.path.localeCompare(b.path)
                );
            }
            return compareDates(a.dreamedAt, b.dreamedAt) || a.path.localeCompare(b.path);
        }),
        (candidate) =>
            candidate.dreamedAt === null
                ? "never dreamed"
                : `last dreamed on ${isoDate(candidate.dreamedAt)}`,
    );

    take("random", shuffle(pool, input.random), () => "picked at random");
    return selections;
}

/**
 * Fisher–Yates shuffle of a copy.
 *
 * @param items - Items.
 * @param random - Uniform random in [0, 1).
 * @returns The shuffled copy.
 */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

/**
 * Compares two dates, ascending; both are expected to be set.
 *
 * @param a - First.
 * @param b - Second.
 * @returns Negative, zero or positive.
 */
function compareDates(a: Date | null, b: Date | null): number {
    return (a?.getTime() ?? 0) - (b?.getTime() ?? 0);
}

/**
 * The UTC calendar date of an instant.
 *
 * @param date - Instant.
 * @returns `YYYY-MM-DD`.
 */
function isoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/**
 * Renders the prompt of one dream run.
 *
 * @param selection - The file and why it was picked.
 * @param sizeBytes - Its current size.
 * @returns The prompt.
 */
export function renderDreamPrompt(selection: DreamSelection, sizeBytes: number): string {
    return `path: ${selection.path}\nsize: ${sizeBytes} bytes\nselected because: ${selection.criterion} — ${selection.reason}`;
}

/** One finished dream, as the `dreams` table keeps it. */
export interface DreamRecord {
    readonly path: string;
    readonly dreamedAt: Date;
    readonly eventId: string | null;
    readonly criterion: string;
    readonly summary: string;
}

/**
 * The dream state next to the wiki index: `files.dreamed_at` / `dreamed_size`
 * and the `dreams` table, which locks a dreamed file for the lock period.
 */
export class DreamStore {
    private readonly index: WikiIndex;

    /**
     * @param index - The wiki index whose schema holds the tables.
     */
    constructor(index: WikiIndex) {
        this.index = index;
    }

    /**
     * Every indexed file with the stats the selection needs. Rows without a
     * size (not re-indexed since dreaming was added) are left out.
     *
     * @returns The candidates.
     */
    async listCandidates(): Promise<readonly DreamCandidate[]> {
        return this.index.db.query<DreamCandidate>(
            `SELECT path, size_bytes AS "sizeBytes", modified_at AS "modifiedAt",
                    first_seen_at AS "firstSeenAt", dreamed_at AS "dreamedAt",
                    dreamed_size AS "dreamedSize"
             FROM ${this.index.schema}.files
             WHERE size_bytes IS NOT NULL AND modified_at IS NOT NULL
             ORDER BY path`,
        );
    }

    /**
     * The latest dream of any file.
     *
     * @returns Its time, or `null` when nothing was dreamed yet.
     */
    async lastDreamedAt(): Promise<Date | null> {
        const rows = await this.index.db.query<{ last: Date | null }>(
            `SELECT max(dreamed_at) AS last FROM ${this.index.schema}.files`,
        );
        return rows[0]?.last ?? null;
    }

    /**
     * The dreams since an instant, newest first.
     *
     * @param since - Start of the window.
     * @returns The dreams.
     */
    async listDreamsSince(since: Date): Promise<readonly DreamRecord[]> {
        return this.index.db.query<DreamRecord & Record<string, unknown>>(
            `SELECT path, dreamed_at AS "dreamedAt", event_id AS "eventId", criterion, summary
             FROM ${this.index.schema}.dreams WHERE dreamed_at >= $1 ORDER BY dreamed_at DESC`,
            [since],
        );
    }

    /**
     * Forgets dreams older than the lock period.
     *
     * @param before - Dreams before this instant go.
     * @returns Resolves once deleted.
     */
    async pruneBefore(before: Date): Promise<void> {
        await this.index.db.query(`DELETE FROM ${this.index.schema}.dreams WHERE dreamed_at < $1`, [
            before,
        ]);
    }

    /**
     * Records a finished dream: a `dreams` row (the lock) and, when the file
     * still exists, its `dreamed_at` / `dreamed_size`.
     *
     * @param dream - Path, event id, criterion, summary, and the size after the run (`undefined` when the file is gone).
     * @returns Resolves once written.
     */
    async record(dream: {
        readonly path: string;
        readonly eventId: string;
        readonly criterion: DreamCriterion;
        readonly summary: string;
        readonly sizeAfter: number | undefined;
    }): Promise<void> {
        await this.index.db.query(
            `INSERT INTO ${this.index.schema}.dreams (path, event_id, criterion, summary) VALUES ($1, $2, $3, $4)`,
            [dream.path, dream.eventId, dream.criterion, dream.summary],
        );
        if (dream.sizeAfter !== undefined) {
            await this.index.db.query(
                `UPDATE ${this.index.schema}.files SET dreamed_at = now(), dreamed_size = $2 WHERE path = $1`,
                [dream.path, dream.sizeAfter],
            );
        }
    }
}
