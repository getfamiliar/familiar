import {
    EVENT_PRIORITY,
    type Logger,
    type NewEvent,
    type ScheduledHandlerBus,
    type ScheduledHandlerNotification,
    type ScheduledHandlerRow,
} from "@getfamiliar/shared";
import { Cron } from "croner";

/**
 * Host-side companion to the container's `schedule_handler` family of
 * tools. Listens to the `scheduled_handlers_changed` NOTIFY channel
 * via {@link ScheduledHandlerBus.listen} and keeps an in-memory map
 * of Croner jobs in sync with the table:
 *
 * - On daemon startup: delete past-due rows (warn-log), then install
 *   one Croner job per still-future row.
 * - On NOTIFY `<key>:u` (insert / update): cancel any existing job
 *   for the key, fetch the new row, install a fresh job.
 * - On NOTIFY `<key>:d` (delete): cancel any existing job.
 * - On job fire: atomically claim-and-delete the row, then emit a
 *   fresh event with the row's topic / handler / prompt / payload.
 *
 * The firing path goes through the same `emit` closure that
 * {@link CronjobScheduler} uses, so cron-fired and one-off events
 * share identical chat-channel stamping and audit behavior.
 */
export class ScheduledHandlerScheduler {
    private readonly bus: ScheduledHandlerBus;
    private readonly emit: (event: NewEvent) => Promise<{ id: string }>;
    private readonly log: Logger;
    private readonly jobs = new Map<string, Cron>();
    private unsubscribe: (() => Promise<void>) | undefined;

    constructor(opts: {
        bus: ScheduledHandlerBus;
        emit: (event: NewEvent) => Promise<{ id: string }>;
        log: Logger;
    }) {
        this.bus = opts.bus;
        this.emit = opts.emit;
        this.log = opts.log;
    }

    /** Past-due cleanup + initial scan + subscribe to live updates. */
    async start(): Promise<void> {
        const nowIso = new Date().toISOString();
        const dropped = await this.bus.deletePastDue(nowIso);
        if (dropped > 0) {
            this.log.warn(
                { dropped },
                `dropped ${dropped} past-due scheduled handler row(s) on startup`,
            );
        }

        const future = await this.bus.listFuture(nowIso);
        for (const row of future) {
            this.install(row);
        }

        this.unsubscribe = await this.bus.listen((notification) =>
            this.onNotification(notification),
        );

        this.log.info({ count: this.jobs.size }, "scheduled-handler scheduler ready");
    }

    /** Cancel every job and detach from NOTIFY. Idempotent. */
    async stop(): Promise<void> {
        if (this.unsubscribe) {
            await this.unsubscribe();
            this.unsubscribe = undefined;
        }
        for (const job of this.jobs.values()) {
            job.stop();
        }
        this.jobs.clear();
    }

    /** Test/diagnostics snapshot: how many jobs are currently armed. */
    size(): number {
        return this.jobs.size;
    }

    private async onNotification(notification: ScheduledHandlerNotification): Promise<void> {
        const existing = this.jobs.get(notification.key);
        if (existing) {
            existing.stop();
            this.jobs.delete(notification.key);
        }

        if (notification.op === "d") {
            this.log.debug({ key: notification.key }, "scheduled handler unscheduled");
            return;
        }

        const row = await this.bus.getByKey(notification.key);
        if (!row) {
            // The row was deleted between the NOTIFY and our SELECT — a
            // racing unschedule, or the scheduler itself just fired and
            // deleted it. Nothing to install.
            this.log.debug(
                { key: notification.key },
                "scheduled handler upsert NOTIFY but row missing — racing delete?",
            );
            return;
        }
        this.install(row);
    }

    /**
     * Install a Croner one-shot for `row.fireAt`. Croner accepts ISO
     * 8601 absolute timestamps directly. `maxRuns: 1` is belt-and-
     * braces — the firing callback also deletes the row, so even a
     * spurious second invocation would be a no-op.
     */
    private install(row: ScheduledHandlerRow): void {
        let job: Cron;
        try {
            job = new Cron(row.fireAt, { maxRuns: 1 }, () => {
                void this.fire(row.key);
            });
        } catch (err) {
            this.log.warn(
                {
                    key: row.key,
                    fireAt: row.fireAt,
                    err: err instanceof Error ? err.message : String(err),
                },
                "could not schedule one-off handler; dropping",
            );
            void this.bus.deleteByKey(row.key).catch(() => {});
            return;
        }
        this.jobs.set(row.key, job);
        this.log.info(
            { key: row.key, fireAt: row.fireAt, topic: row.topic, handler: row.handler },
            "scheduled handler armed",
        );
    }

    private async fire(key: string): Promise<void> {
        this.jobs.delete(key);

        let row: ScheduledHandlerRow | undefined;
        try {
            row = await this.bus.claimAndDeleteForFiring(key);
        } catch (err) {
            this.log.error(
                { key, err: err instanceof Error ? err.message : String(err) },
                "scheduled handler claim failed",
            );
            return;
        }
        if (!row) {
            this.log.debug({ key }, "scheduled handler fired but row already gone");
            return;
        }

        const prompt = row.prompt ?? "Scheduled handler fired";
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        const event: NewEvent = {
            topic: row.topic,
            startHandler: row.handler,
            prompt,
            priority: row.priority ?? EVENT_PRIORITY.BACKGROUND,
            privileged: row.privileged,
            payload,
        };
        try {
            const handle = await this.emit(event);
            this.log.info(
                { key, eventId: handle.id, topic: row.topic, handler: row.handler },
                "scheduled handler fired",
            );
        } catch (err) {
            this.log.error(
                {
                    key,
                    topic: row.topic,
                    handler: row.handler,
                    err: err instanceof Error ? err.message : String(err),
                },
                "scheduled handler fired but emit failed",
            );
        }
    }
}
