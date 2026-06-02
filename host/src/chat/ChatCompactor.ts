import { existsSync } from "node:fs";
import path from "node:path";
import {
    CHATMESSAGES_NEW_CHANNEL,
    type ConfigService,
    DuplicateIdempotencyKeyError,
    EVENT_PRIORITY,
    type HostContext,
    type Logger,
    type NewEvent,
    type NotificationHandler,
    type PostgresConnection,
} from "@getfamiliar/shared";

/** Default upper bound on total `chatmessages` bytes before compaction fires. */
export const DEFAULT_COMPACTION_THRESHOLD_BYTES = 60_000;

/** Default amount of recent history kept verbatim when compacting. */
export const DEFAULT_KEEP_UNCOMPACTED_BYTES = 30_000;

/** Workspace-relative path of the default summarisation handler. */
const COMPACTION_HANDLER_RELATIVE_PATH = path.join("chat", "compaction", "index.md");

/**
 * Dependencies the {@link ChatCompactor} needs from its owner.
 *
 * Kept narrow so the compactor stays unit-testable: tests stub each
 * field rather than spinning up the full host wiring. The owner
 * (typically the daemon `Start` command) is responsible for the
 * lifetimes of the {@link PostgresConnection} and {@link HostContext}
 * passed in.
 */
export interface ChatCompactorDeps {
    /** Open postgres connection used for queries and LISTEN. */
    readonly connection: PostgresConnection;
    /**
     * Host context the compactor calls to emit the `chat:compaction`
     * event. Going through the ctx (rather than raw {@link EventBus})
     * gives us the same defaults stamping (`core.defaultChatChannel`
     * on `preferredChatChannelId`) every other host emitter sees, and
     * an {@link EmitHandle} whose `settled` promise resolves with the
     * agentrun's summary text.
     */
    readonly host: HostContext;
    /**
     * Absolute path of the workspace directory (`data/workspace`). Used
     * to probe for the optional `chat/compaction/index.md` handler — if
     * it's missing the compactor falls back to plain truncation.
     */
    readonly workspaceDir: string;
    /** Host config; read for the two `chat.compaction.*` thresholds. */
    readonly config: ConfigService;
    /** Scoped logger; `{ component: "chat-compactor" }` recommended. */
    readonly log: Logger;
}

/** Row shape returned by the newest-first walk over `chatmessages`. */
export interface CompactionRow {
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly textContent: string;
    readonly createdAt: Date;
    readonly byteSize: number;
}

/** Result of the split-point walk; `ids` is empty when nothing falls outside the keep window. */
export interface CompactionBatch {
    readonly ids: readonly string[];
    readonly transcript: string;
    readonly maxId: string;
    readonly boundaryCreatedAt: Date;
}

/**
 * Pure split-point walk. Iterates `rowsNewestFirst` accumulating
 * `byteSize`; the first row whose addition would push the running total
 * past `keepUncompactedBytes` becomes the boundary and goes into the
 * to-compact set along with every older row. Returns the captured ids
 * in chronological order, the joined transcript, the maximum captured
 * id (for the idempotency key), and the boundary timestamp (the
 * newest compacted row's `createdAt`, used to place the summary
 * immediately before the oldest kept message under the read path's
 * `ORDER BY created_at ASC, id ASC`).
 *
 * Exported and pure so the split-point math is unit-testable without
 * any DB or filesystem stubs.
 */
export function selectCompactionBatch(
    rowsNewestFirst: readonly CompactionRow[],
    keepUncompactedBytes: number,
): CompactionBatch {
    const toCompact: CompactionRow[] = [];
    let runningBytes = 0;
    for (const row of rowsNewestFirst) {
        if (runningBytes + row.byteSize > keepUncompactedBytes) {
            toCompact.push(row);
            continue;
        }
        runningBytes += row.byteSize;
    }

    if (toCompact.length === 0) {
        return { ids: [], transcript: "", maxId: "0", boundaryCreatedAt: new Date(0) };
    }

    // Captured rows arrived newest→oldest; flip to chronological so the
    // transcript reads naturally and the boundary row sits at the end.
    toCompact.reverse();
    const transcript = formatTranscript(toCompact);
    const boundary = toCompact[toCompact.length - 1];

    let maxId = toCompact[0].id;
    for (const row of toCompact) {
        if (BigInt(row.id) > BigInt(maxId)) {
            maxId = row.id;
        }
    }

    return {
        ids: toCompact.map((r) => r.id),
        transcript,
        maxId,
        boundaryCreatedAt: boundary.createdAt,
    };
}

/**
 * Render the to-compact rows as the prompt text the handler will see:
 * each row on its own paragraph prefixed by `user:` / `assistant:`,
 * joined by blank lines. Exported so the transcript format is
 * test-anchored — handler authors rely on it.
 */
export function formatTranscript(rowsChronological: readonly CompactionRow[]): string {
    return rowsChronological.map((row) => `${row.role}: ${row.textContent}`).join("\n\n");
}

/**
 * Background service that keeps the `chatmessages` table from growing
 * without bound.
 *
 * Lifecycle: one instance per host daemon. {@link start} subscribes to
 * the existing `chatmessages_new` NOTIFY channel; {@link stop} tears
 * the subscription down. Every notification triggers a
 * {@link maybeCompact} pass.
 *
 * Compaction algorithm (table-global; `chatmessages` is one shared log
 * across all chat plugins — no per-channel partition exists in the
 * project):
 *
 * 1. Compute total bytes via `SUM(octet_length(text_content))`.
 * 2. If under `thresholdBytes`, return.
 * 3. Walk rows newest→oldest, accumulating bytes. The first row that
 *    would push the running total past `keepUncompactedBytes` is the
 *    boundary: it and every older row form the *to-compact* set.
 * 4. If the handler markdown is missing, log a warning and fall back to
 *    deleting the to-compact rows (no event emitted).
 * 5. Otherwise emit `chat:compaction` with the chronological transcript
 *    as `prompt`. Await the agentrun's final text via `handle.settled`.
 * 6. In one transaction, DELETE the to-compact rows and INSERT a single
 *    user-role row containing the summary, attached to the compaction
 *    event. The summary's `created_at` is set to the boundary row's
 *    timestamp so it sorts immediately *before* the oldest kept message
 *    (the read path uses `ORDER BY created_at ASC, id ASC`).
 *
 * Concurrency: a single in-memory `inFlight` flag prevents overlapping
 * runs. The compactor also uses an idempotency key derived from the
 * batch's highest message id so two near-simultaneous host instances
 * (or restart races) collapse to one event.
 */
export class ChatCompactor {
    private readonly deps: ChatCompactorDeps;
    private readonly thresholdBytes: number;
    private readonly keepUncompactedBytes: number;
    private readonly notifyHandler: NotificationHandler;
    private listening = false;
    private inFlight = false;

    constructor(deps: ChatCompactorDeps) {
        this.deps = deps;
        this.thresholdBytes = deps.config.getNumber(
            "chat.compaction.thresholdBytes",
            DEFAULT_COMPACTION_THRESHOLD_BYTES,
        );
        this.keepUncompactedBytes = deps.config.getNumber(
            "chat.compaction.keepUncompactedBytes",
            DEFAULT_KEEP_UNCOMPACTED_BYTES,
        );
        if (this.keepUncompactedBytes >= this.thresholdBytes) {
            // A misconfigured pair would compact forever (split point
            // sits past the trigger threshold). Fail loud at boot.
            throw new Error(
                `chat.compaction.keepUncompactedBytes (${this.keepUncompactedBytes}) must be less than chat.compaction.thresholdBytes (${this.thresholdBytes})`,
            );
        }
        this.notifyHandler = () => {
            void this.maybeCompact().catch((err) => {
                this.deps.log.error(
                    { err: err instanceof Error ? err.message : String(err) },
                    "chat compactor maybeCompact threw",
                );
            });
        };
    }

    /** Subscribe to `chatmessages_new` and start compacting on demand. */
    async start(): Promise<void> {
        if (this.listening) {
            return;
        }
        await this.deps.connection.listen(CHATMESSAGES_NEW_CHANNEL, this.notifyHandler);
        this.listening = true;
        this.deps.log.info(
            `chat compactor started (thresholdBytes=${this.thresholdBytes}, keepUncompactedBytes=${this.keepUncompactedBytes})`,
        );
        // Catch up on any pending compaction from prior runs (e.g. the
        // daemon was killed mid-grow). Cheap when nothing's pending.
        this.notifyHandler("");
    }

    /** Unsubscribe and stop processing future notifications. */
    async stop(): Promise<void> {
        if (!this.listening) {
            return;
        }
        this.listening = false;
        await this.deps.connection.unlisten(CHATMESSAGES_NEW_CHANNEL, this.notifyHandler);
        this.deps.log.info("chat compactor stopped");
    }

    /**
     * Run one compaction pass if conditions are met. Public for tests
     * and for the wakeup-from-stop catch-up call in {@link start}.
     * Concurrency-safe via the {@link inFlight} flag — overlapping
     * notifications collapse to a single pass.
     */
    async maybeCompact(): Promise<void> {
        if (this.inFlight) {
            return;
        }
        this.inFlight = true;
        try {
            const totalBytes = await this.fetchTotalBytes();
            if (totalBytes <= this.thresholdBytes) {
                return;
            }

            const batch = await this.collectToCompactBatch();
            if (batch.ids.length === 0) {
                // Nothing older than the keep window even though we're
                // over threshold — every row sits inside the kept set
                // (one really long recent message, or pathologically
                // small keep window). Nothing safe to compact.
                this.deps.log.warn(
                    {
                        totalBytes,
                        thresholdBytes: this.thresholdBytes,
                        keepUncompactedBytes: this.keepUncompactedBytes,
                    },
                    "chat compaction triggered but nothing falls outside the keep window",
                );
                return;
            }

            const handlerPath = path.join(this.deps.workspaceDir, COMPACTION_HANDLER_RELATIVE_PATH);
            if (!existsSync(handlerPath)) {
                this.deps.log.warn(
                    { handlerPath, deleted: batch.ids.length },
                    "chat compaction handler missing — falling back to truncation",
                );
                await this.deleteRows(batch.ids);
                return;
            }

            const summary = await this.runHandlerEvent(batch);
            if (summary === undefined) {
                return;
            }
            await this.replaceWithSummary(batch, summary);
            this.deps.log.info(
                {
                    deleted: batch.ids.length,
                    summaryBytes: Buffer.byteLength(summary, "utf8"),
                    totalBytesBefore: totalBytes,
                },
                "chat compaction completed",
            );
        } finally {
            this.inFlight = false;
        }
    }

    /** `SUM(octet_length(text_content))` across the whole table. */
    private async fetchTotalBytes(): Promise<number> {
        const result = await this.deps.connection.getPool().query<{ total: string | null }>(
            `SELECT COALESCE(SUM(octet_length(text_content)), 0)::text AS total
             FROM chatmessages`,
        );
        const raw = result.rows[0]?.total ?? "0";
        return Number.parseInt(raw, 10);
    }

    /**
     * Fetch every row newest→oldest and hand them to
     * {@link selectCompactionBatch}. Thin DB shim so the split-point
     * math stays pure and unit-testable.
     */
    private async collectToCompactBatch(): Promise<CompactionBatch> {
        const result = await this.deps.connection.getPool().query<{
            id: string;
            role: "user" | "assistant";
            text_content: string;
            created_at: Date;
            byte_size: string;
        }>(
            `SELECT id, role, text_content, created_at,
                    octet_length(text_content)::text AS byte_size
             FROM chatmessages
             ORDER BY created_at DESC, id DESC`,
        );

        const rows: CompactionRow[] = result.rows.map((row) => ({
            id: row.id,
            role: row.role,
            textContent: row.text_content,
            createdAt: row.created_at,
            byteSize: Number.parseInt(row.byte_size, 10),
        }));

        return selectCompactionBatch(rows, this.keepUncompactedBytes);
    }

    /**
     * Emit the `chat:compaction` event and await the agentrun's summary
     * text. Returns the trimmed summary, or `undefined` when the event
     * couldn't run (idempotency collision, agentrun failure, empty
     * reply) — caller treats `undefined` as "do nothing this pass".
     */
    private async runHandlerEvent(batch: CompactionBatch): Promise<string | undefined> {
        const event: NewEvent = {
            topic: "chat:compaction",
            prompt: batch.transcript,
            isChat: false,
            priority: EVENT_PRIORITY.BACKGROUND,
            idempotencyKey: `chat-compaction:${batch.maxId}`,
            payload: { messageIds: [...batch.ids] },
        };

        let handle: Awaited<ReturnType<HostContext["events"]["emit"]>>;
        try {
            handle = await this.deps.host.events.emit(event);
        } catch (err) {
            if (err instanceof DuplicateIdempotencyKeyError) {
                this.deps.log.debug(
                    { idempotencyKey: event.idempotencyKey },
                    "chat compaction event already in flight — skipping",
                );
                return undefined;
            }
            throw err;
        }

        let summary: string;
        try {
            summary = (await handle.settled).trim();
        } catch (err) {
            this.deps.log.warn(
                {
                    eventId: handle.id,
                    err: err instanceof Error ? err.message : String(err),
                    rowsAffected: batch.ids.length,
                },
                "chat compaction agentrun failed — leaving messages untouched",
            );
            return undefined;
        }

        if (summary.length === 0) {
            this.deps.log.warn(
                { eventId: handle.id, rowsAffected: batch.ids.length },
                "chat compaction agentrun returned an empty summary — leaving messages untouched",
            );
            return undefined;
        }
        return summary;
    }

    /**
     * Atomically delete the captured rows and insert the summary in
     * one transaction. The summary is attached to the compaction event
     * itself (so the chronological position falls between the deleted
     * and kept rows) and stored with role `'user'` so it reads as
     * established context to future agentruns. The summary's
     * `created_at` is the boundary row's timestamp — see
     * {@link collectToCompactBatch} for why.
     *
     * The handler's compaction event id is recovered by looking it up
     * via the same idempotency key we used in {@link runHandlerEvent}.
     */
    private async replaceWithSummary(batch: CompactionBatch, summary: string): Promise<void> {
        const pool = this.deps.connection.getPool();
        const eventLookup = await pool.query<{ id: string }>(
            `SELECT id FROM events WHERE idempotency_key = $1`,
            [`chat-compaction:${batch.maxId}`],
        );
        const eventId = eventLookup.rows[0]?.id;
        if (!eventId) {
            // Shouldn't happen — we just emitted it. Belt-and-suspenders.
            throw new Error(
                `chat compaction event with idempotency key chat-compaction:${batch.maxId} not found after emit`,
            );
        }
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`DELETE FROM chatmessages WHERE id = ANY($1::bigint[])`, [
                batch.ids,
            ]);
            await client.query(
                `INSERT INTO chatmessages (event_id, role, text_content, created_at)
                 VALUES ($1, 'user', $2, $3)`,
                [eventId, summary, batch.boundaryCreatedAt],
            );
            await client.query("COMMIT");
        } catch (err) {
            try {
                await client.query("ROLLBACK");
            } catch {
                // best-effort rollback; preserve original error
            }
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Truncation fallback when the handler markdown is missing. Deletes
     * the captured rows; no event is emitted, no summary written.
     */
    private async deleteRows(ids: ReadonlyArray<string>): Promise<void> {
        await this.deps.connection
            .getPool()
            .query(`DELETE FROM chatmessages WHERE id = ANY($1::bigint[])`, [ids]);
    }
}
