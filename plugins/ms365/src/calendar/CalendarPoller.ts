import path from "node:path";
import type { CalendarApi, CalendarRow, HostContext } from "@getfamiliar/shared";
import { Cron } from "croner";
import type { GraphAuth } from "../auth/GraphAuth.js";
import type { LoginStore } from "../auth/LoginStore.js";
import type { Ms365CalendarConfig } from "../Config.js";
import {
    type CalendarDeltaPage,
    type GraphCalendar,
    type GraphCalendarEvent,
    GraphClient,
    GraphError,
} from "../graph/GraphClient.js";
import { CalendarCursorStore } from "./CalendarCursorStore.js";
import {
    calendarTypeOf,
    eventFromGraph,
    MS365_PROVIDER_ID,
    mergeWithMaster,
    ownerNameOf,
} from "./Mapping.js";

/** Hard ceiling on pages per (calendar, poll) so a runaway feed can't park the loop. */
const MAX_PAGES_PER_POLL = 50;

/**
 * Per-page retry policy for Graph 5xx responses. Graph's
 * `calendarView/delta` returns 502/503/504 with some regularity (Azure
 * front-end gateway hiccups) — propagating those to the watcher's
 * exponential-backoff path would mark the whole poller as failing
 * after a single blip, which is the wrong signal. Retrying twice with
 * short delays converts almost every transient blip into a
 * recovered-quietly poll without significantly slowing down a real
 * outage. Two retries × max 5 s = 10 s extra latency in the worst
 * case, well inside the 15-min default poll interval.
 *
 * `410 Gone` is explicitly excluded: it's the documented "delta cursor
 * expired" signal and is handled separately by dropping the cursor.
 */
const TRANSIENT_RETRY_DELAYS_MS = [2_000, 5_000] as const;

/** Inputs the daemon hands the poller at construction. */
export interface CalendarPollerOptions {
    readonly ctx: HostContext;
    readonly calendarConfig: Ms365CalendarConfig;
    readonly logins: LoginStore;
    readonly calendarApi: CalendarApi;
    readonly log: (msg: string) => void;
    /** Cron schedule for the full re-walk (parsed elsewhere). */
    readonly refreshExpression: string;
}

/**
 * One concrete `(login, calendar)` pairing the poller iterates over.
 * Owns both the live `GraphAuth` token provider and the local row
 * id used as `calendar_id` in `calendar_events`.
 */
interface PollTarget {
    readonly upn: string;
    readonly auth: GraphAuth;
    readonly graphCalendarId: string;
    readonly row: CalendarRow;
}

/**
 * Calendar polling worker for Microsoft 365. Owns its own delta
 * cursor store at `data/ms365/calendar/delta.json`. Mirrors the mail
 * poller's structure (`prepare` discovery pass, per-cycle `pollOnce`,
 * 410 reset) and additionally schedules a periodic *full re-walk* via
 * the configured friendly-cron expression.
 *
 * The refresh walk uses the core's scan-generation mechanism:
 * `beginRefresh` bumps the generation on the calendar row, we upsert
 * every event in the configured window tagged with the new value, then
 * `endRefresh` deletes everything still tagged with an older
 * generation. Crash mid-walk is safe — the next refresh raises the
 * tag again and cleans up earlier remnants together.
 */
export class CalendarPoller {
    private readonly opts: CalendarPollerOptions;
    private readonly cursorStore: CalendarCursorStore;
    private targets: ReadonlyArray<PollTarget>;
    private refreshJob: Cron | undefined;

    private constructor(
        opts: CalendarPollerOptions,
        cursorStore: CalendarCursorStore,
        targets: ReadonlyArray<PollTarget>,
    ) {
        this.opts = opts;
        this.cursorStore = cursorStore;
        this.targets = targets;
    }

    /**
     * Discover subscribable calendars on every valid login, upsert
     * them into the core `calendars` table as seeded rows, and return
     * a ready-to-poll worker. Returns `null` when nothing is reachable.
     */
    static async prepare(opts: CalendarPollerOptions): Promise<CalendarPoller | null> {
        const { ctx, logins, log, calendarApi, calendarConfig } = opts;
        const cursorStore = new CalendarCursorStore(
            path.join(ctx.dataDir, "ms365", "calendar", "delta.json"),
        );
        await cursorStore.load();

        const validations = await logins.validateAll();
        const valid: { upn: string; auth: GraphAuth }[] = [];
        for (const v of validations) {
            if (v.ok) {
                valid.push({ upn: v.upn, auth: v.auth });
            }
        }
        if (valid.length === 0) {
            log("calendar: no usable ms365 logins; not polling calendars");
            return null;
        }

        const targets: PollTarget[] = [];
        for (const login of valid) {
            const client = new GraphClient(() => login.auth.getAccessTokenSilent());
            let calendars: readonly GraphCalendar[];
            try {
                calendars = await client.listCalendars(login.upn);
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                log(`calendar: listCalendars failed for ${login.upn}: ${reason}; skipping`);
                continue;
            }
            const selection = selectCalendars(calendars, calendarConfig.calendars);
            for (const graphCalendar of selection) {
                const type = calendarTypeOf(graphCalendar, login.upn);
                const row = await calendarApi.upsertCalendar({
                    pluginId: MS365_PROVIDER_ID,
                    uniqueKey: graphCalendar.id,
                    name: graphCalendar.name,
                    type,
                    ownerName: ownerNameOf(graphCalendar, type),
                    isDefault: graphCalendar.isDefaultCalendar === true,
                });
                targets.push({
                    upn: login.upn,
                    auth: login.auth,
                    graphCalendarId: graphCalendar.id,
                    row,
                });
            }
        }

        if (targets.length === 0) {
            log("calendar: no calendars matched the subscription list; nothing to poll");
            return null;
        }

        log(
            `calendar: subscribed to ${targets.length} calendar${targets.length === 1 ? "" : "s"}: ` +
                targets.map((t) => `${t.row.name} (${t.row.type})`).join(", "),
        );

        const poller = new CalendarPoller(opts, cursorStore, targets);
        // Install the refresh cron immediately. Croner's constructor
        // schedules its first fire; we don't want refresh to fire
        // during the initial seed walk that happens in `pollOnce`, so
        // we install it AFTER the daemon's first tick — `start()` is
        // called separately by the daemon.
        return poller;
    }

    /**
     * Install the configured friendly-cron expression as a refresh
     * job. Refresh runs the full re-walk with scan-generation tagging
     * for every target calendar. The job is unref'd so it does not
     * keep the daemon alive on its own.
     */
    startRefreshCron(log: (msg: string) => void): void {
        if (this.refreshJob) {
            return;
        }
        try {
            this.refreshJob = new Cron(this.opts.refreshExpression, () => {
                void this.refreshAll().catch((err) => {
                    const message = err instanceof Error ? err.message : String(err);
                    log(`calendar: refresh job error: ${message}`);
                });
            });
            log(`calendar: refresh cron scheduled (${this.opts.refreshExpression})`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log(
                `calendar: invalid refresh expression "${this.opts.refreshExpression}": ${message}`,
            );
        }
    }

    /** Run one poll pass for every target calendar (delta-incremental). */
    async pollOnce(): Promise<void> {
        for (const target of this.targets) {
            try {
                await this.pollOneIncremental(target);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.opts.log(
                    `calendar ${target.row.name} via ${target.upn}: poll error: ${message}`,
                );
            }
        }
    }

    /**
     * Full re-walk of every target calendar against the configured
     * window. Bumps `scan_generation`, upserts every event with the
     * new value (NOT seeded — so genuinely new events still emit
     * `calendar:new`), then deletes anything still on an older
     * generation.
     */
    async refreshAll(): Promise<void> {
        for (const target of this.targets) {
            try {
                await this.refreshOne(target);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.opts.log(
                    `calendar ${target.row.name} via ${target.upn}: refresh error: ${message}`,
                );
            }
        }
    }

    private async pollOneIncremental(target: PollTarget): Promise<void> {
        const client = new GraphClient(() => target.auth.getAccessTokenSilent());
        let cursor: string | null = this.cursorStore.get(target.upn, target.graphCalendarId);
        const isFreshWalk = cursor === null;
        const { startDateTime, endDateTime } = this.windowIso();
        let nextDeltaLink: string | null = null;
        let pages = 0;
        while (pages < MAX_PAGES_PER_POLL) {
            pages += 1;
            let page: CalendarDeltaPage;
            try {
                page = await this.fetchDeltaPage(
                    client,
                    target,
                    startDateTime,
                    endDateTime,
                    cursor,
                );
            } catch (err) {
                if (err instanceof GraphError && err.status === 410) {
                    this.opts.log(
                        `calendar ${target.row.name}: delta cursor expired (410); resetting`,
                    );
                    await this.cursorStore.drop(target.upn, target.graphCalendarId);
                    cursor = null;
                    continue;
                }
                throw err;
            }
            await this.persistPage(target, page.value, {
                seed: isFreshWalk,
                scanGeneration: target.row.scanGeneration,
            });
            if (page.deltaLink !== null) {
                nextDeltaLink = page.deltaLink;
                break;
            }
            if (page.nextLink === null) {
                break;
            }
            cursor = page.nextLink;
        }
        if (nextDeltaLink !== null) {
            await this.cursorStore.set(target.upn, target.graphCalendarId, nextDeltaLink);
        }
    }

    private async refreshOne(target: PollTarget): Promise<void> {
        const client = new GraphClient(() => target.auth.getAccessTokenSilent());
        const gen = await this.opts.calendarApi.beginRefresh(target.row.id);
        const { startDateTime, endDateTime } = this.windowIso();
        // Refresh ignores the per-calendar delta cursor — it walks
        // the whole window from scratch. New events still emit
        // `calendar:new` (the PK doesn't exist yet); known events
        // are upserted into the new generation in place.
        let pages = 0;
        let cursor: string | null = null;
        while (pages < MAX_PAGES_PER_POLL) {
            pages += 1;
            const page = await this.fetchDeltaPage(
                client,
                target,
                startDateTime,
                endDateTime,
                cursor,
            );
            // Refresh deletes by generation, not by tombstone — drop
            // @removed items here and let `persistPage` handle the
            // master-first ordering for the rest.
            const items = page.value.filter((item) => !item["@removed"]);
            await this.persistPage(target, items, {
                seed: false,
                scanGeneration: gen,
            });
            if (page.deltaLink !== null) {
                // Persist the new delta link for the incremental loop
                // so the next pollOnce picks up after the refresh
                // window.
                await this.cursorStore.set(target.upn, target.graphCalendarId, page.deltaLink);
                break;
            }
            if (page.nextLink === null) {
                break;
            }
            cursor = page.nextLink;
        }
        const removed = await this.opts.calendarApi.endRefresh(target.row.id, gen);
        if (removed.removed > 0) {
            this.opts.log(
                `calendar ${target.row.name}: refresh removed ${removed.removed} stale row(s)`,
            );
        }
    }

    /**
     * Fetch one delta page with a small retry loop around transient
     * 5xx responses. 410 (expired cursor) and 4xx (auth, bad request)
     * propagate immediately so the calling site can recover or fail
     * loud as appropriate.
     */
    private async fetchDeltaPage(
        client: GraphClient,
        target: PollTarget,
        startDateTime: string,
        endDateTime: string,
        cursor: string | null,
    ): Promise<CalendarDeltaPage> {
        let attempt = 0;
        for (;;) {
            try {
                return await client.listCalendarViewDelta(
                    target.upn,
                    target.graphCalendarId,
                    startDateTime,
                    endDateTime,
                    cursor,
                );
            } catch (err) {
                if (!isTransientGraphError(err) || attempt >= TRANSIENT_RETRY_DELAYS_MS.length) {
                    throw err;
                }
                const delayMs = TRANSIENT_RETRY_DELAYS_MS[attempt];
                attempt += 1;
                const message = err instanceof Error ? err.message : String(err);
                this.opts.log(
                    `calendar ${target.row.name}: transient Graph error (${message}); ` +
                        `retry ${attempt}/${TRANSIENT_RETRY_DELAYS_MS.length} in ${delayMs}ms`,
                );
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, delayMs).unref();
                });
            }
        }
    }

    /**
     * Persist one delta page in two passes so occurrences can inherit
     * fields from their series master:
     *
     *   1. Tombstones (`@removed`) → removeEvent.
     *   2. Masters (`type === 'seriesMaster'`) → addEvent. Done before
     *      pass 3 so the cache lookup in pass 3 succeeds for any
     *      master present in this very page (Graph usually orders
     *      master-first but we don't rely on it).
     *   3. Everything else (`singleInstance`, `occurrence`,
     *      `exception`) → mergeWithMaster from the local cache when
     *      `seriesMasterId` is set, then addEvent.
     *
     * A missing master (cross-calendar reference, race with deletion)
     * leaves the occurrence as-is — better to surface partial data
     * than to drop the row entirely.
     */
    private async persistPage(
        target: PollTarget,
        items: readonly GraphCalendarEvent[],
        opts: { readonly seed: boolean; readonly scanGeneration: number },
    ): Promise<void> {
        for (const item of items) {
            if (item["@removed"]) {
                await this.opts.calendarApi.removeEvent(`${MS365_PROVIDER_ID}:${item.id}`);
            }
        }

        const masters: GraphCalendarEvent[] = [];
        const others: GraphCalendarEvent[] = [];
        for (const item of items) {
            if (item["@removed"]) {
                continue;
            }
            if (item.type === "seriesMaster") {
                masters.push(item);
            } else {
                others.push(item);
            }
        }

        for (const item of masters) {
            const row = eventFromGraph(item, {
                calendarId: target.row.id,
                scanGeneration: opts.scanGeneration,
            });
            await this.opts.calendarApi.addEvent(row, { seed: opts.seed });
        }

        for (const item of others) {
            let row = eventFromGraph(item, {
                calendarId: target.row.id,
                scanGeneration: opts.scanGeneration,
            });
            if (row.seriesMasterId) {
                const master = await this.opts.calendarApi.getEvent(row.seriesMasterId);
                if (master) {
                    row = mergeWithMaster(row, master);
                }
            }
            await this.opts.calendarApi.addEvent(row, { seed: opts.seed });
        }
    }

    private windowIso(): { startDateTime: string; endDateTime: string } {
        const now = new Date();
        const lookback = this.opts.calendarConfig.lookbackDays;
        const lookahead = this.opts.calendarConfig.lookaheadDays;
        const start = new Date(now.getTime() - lookback * 24 * 60 * 60 * 1000);
        const end = new Date(now.getTime() + lookahead * 24 * 60 * 60 * 1000);
        return {
            startDateTime: start.toISOString(),
            endDateTime: end.toISOString(),
        };
    }
}

/**
 * True when a Graph response should be re-attempted before bubbling
 * up. Any 5xx counts; 410 (cursor expired) is *not* transient
 * because it has a documented recovery path (drop + restart) the
 * caller handles separately, and 429 should be respected verbatim
 * once we plumb Retry-After through.
 */
function isTransientGraphError(err: unknown): boolean {
    if (!(err instanceof GraphError)) {
        return false;
    }
    return err.status >= 500 && err.status <= 599;
}

/**
 * Reconcile the configured calendar list against what `/me/calendars`
 * returned for one login. Empty config → just the default calendar.
 * Non-empty config → match by `name` (case-insensitive); unmatched
 * names are silently skipped (logged elsewhere).
 */
function selectCalendars(
    available: readonly GraphCalendar[],
    configured: readonly string[],
): readonly GraphCalendar[] {
    if (configured.length === 0) {
        const def = available.find((c) => c.isDefaultCalendar);
        if (def) {
            return [def];
        }
        return available.slice(0, 1);
    }
    const wanted = new Set(configured.map((n) => n.toLowerCase()));
    return available.filter((c) => typeof c.name === "string" && wanted.has(c.name.toLowerCase()));
}
