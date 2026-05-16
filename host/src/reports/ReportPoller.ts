import {
    AgentRunBus,
    type AgentRunRow,
    EventBus,
    type EventRow,
    type Logger,
    type PostgresConnection,
    StepResultBus,
    type StepResultRow,
} from "@getfamiliar/shared";

/**
 * Sink that the {@link ReportPoller} drives. Both the daemon-side
 * file writer and the live `report tail` printer implement this
 * interface; the poller is unaware of which is consuming it.
 *
 * `kind: "new"` fires the first time the poller observes a row.
 * `kind: "state-changed"` fires only when a previously-observed row
 * arrives with a state value different from the last one we saw —
 * notably `pending → running → done|failed`. Steps are immutable, so
 * `onStepResult` carries no kind discriminator.
 */
export interface ReportSink {
    onEvent(row: EventRow, kind: "new" | "state-changed"): Promise<void>;
    onAgentrun(row: AgentRunRow, kind: "new" | "state-changed"): Promise<void>;
    onStepResult(row: StepResultRow): Promise<void>;
}

export interface ReportPollerOptions {
    readonly connection: PostgresConnection;
    readonly sink: ReportSink;
    readonly intervalMs?: number;
    readonly startAnchor?: Date;
    readonly log?: Logger;
}

/**
 * Polls events / agentruns / stepresults at a fixed cadence and
 * emits new + state-changed rows to a {@link ReportSink}. No NOTIFY
 * subscription, no schema additions — the only footprint on
 * postgres is three SELECTs per cycle. That's deliberate: the
 * report layer is audit-only and shouldn't clutter the bus's
 * event-driven core.
 *
 * Anchors are kept per table as `Date` mtimes (events / agentruns
 * via `updated_at`, the immutable stepresults via `created_at`).
 * After each cycle the anchor advances to `max(mtime) + 1ms` so the
 * next cycle's `>= anchor` predicate doesn't re-pull the same boundary
 * row; same-millisecond ties are handled by the per-id dedupe maps.
 */
export class ReportPoller {
    private readonly events: EventBus;
    private readonly agentruns: AgentRunBus;
    private readonly steps: StepResultBus;
    private readonly sink: ReportSink;
    private readonly intervalMs: number;
    private readonly log?: Logger;

    private eventsAnchor: Date;
    private agentrunsAnchor: Date;
    private stepresultsAnchor: Date;

    private readonly seenEvents = new Set<string>();
    private readonly seenAgentruns = new Set<string>();
    private readonly seenSteps = new Set<string>();
    private readonly terminalEvents = new Set<string>();
    private readonly terminalAgentruns = new Set<string>();

    constructor(opts: ReportPollerOptions) {
        this.events = new EventBus(opts.connection);
        this.agentruns = new AgentRunBus(opts.connection);
        this.steps = new StepResultBus(opts.connection);
        this.sink = opts.sink;
        this.intervalMs = opts.intervalMs ?? 1000;
        this.log = opts.log;
        const anchor = opts.startAnchor ?? new Date();
        this.eventsAnchor = anchor;
        this.agentrunsAnchor = anchor;
        this.stepresultsAnchor = anchor;
    }

    /**
     * Run the poll loop until `signal` aborts. Each cycle: query
     * events, agentruns, then stepresults; dispatch any new or
     * state-changed rows to the sink; sleep `intervalMs`. Errors in
     * a single cycle are logged and swallowed so a transient DB
     * blip doesn't kill the loop.
     */
    async start(signal?: AbortSignal): Promise<void> {
        for (;;) {
            if (signal?.aborted) {
                return;
            }
            try {
                await this.pollOnce();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.log?.warn({ err: message }, "report poller: cycle error, continuing");
            }
            if (signal?.aborted) {
                return;
            }
            await sleep(this.intervalMs, signal);
        }
    }

    private async pollOnce(): Promise<void> {
        // Pull all three tables up front so the per-cycle phase
        // ordering below operates on a consistent snapshot. Phases
        // run in narrative order: new events → new agentruns →
        // stepresults → terminal agentruns → terminal events. That
        // way an event whose root agentrun finished within the same
        // tick prints `event-created → agentrun-start → step* →
        // agentrun-result → event-result`, instead of the
        // back-to-front ordering a naive query-and-emit-per-table
        // pass produces.
        const eventRows = await this.events.listSince(this.eventsAnchor);
        const runRows = await this.agentruns.listSince(this.agentrunsAnchor);
        const stepRows = await this.steps.listSince(this.stepresultsAnchor);

        // Phase 1 — event creations.
        for (const row of eventRows) {
            if (!this.seenEvents.has(row.id)) {
                this.seenEvents.add(row.id);
                await this.sink.onEvent(row, "new");
            }
        }

        // Phase 2 — agentrun creations.
        for (const row of runRows) {
            if (!this.seenAgentruns.has(row.id)) {
                this.seenAgentruns.add(row.id);
                await this.sink.onAgentrun(row, "new");
            }
        }

        // Phase 3 — step inserts (immutable; first-sighting only).
        for (const row of stepRows) {
            if (this.seenSteps.has(row.id)) {
                continue;
            }
            this.seenSteps.add(row.id);
            await this.sink.onStepResult(row);
        }

        // Phase 4 — agentrun terminal transitions. Sinks already
        // ignore non-terminal state-changed emissions, so we filter
        // here too — keeps the phase contract crisp and avoids
        // spurious DB queries (the file writer fans out to
        // `listByAgentRunId` on each emit).
        for (const row of runRows) {
            if (row.state !== "done" && row.state !== "failed") {
                continue;
            }
            if (this.terminalAgentruns.has(row.id)) {
                continue;
            }
            this.terminalAgentruns.add(row.id);
            await this.sink.onAgentrun(row, "state-changed");
        }

        // Phase 5 — event terminal transitions.
        for (const row of eventRows) {
            if (row.state !== "done" && row.state !== "failed") {
                continue;
            }
            if (this.terminalEvents.has(row.id)) {
                continue;
            }
            this.terminalEvents.add(row.id);
            await this.sink.onEvent(row, "state-changed");
        }

        // Anchors advance after all phases so a row that appears
        // only in this cycle's first three phases (e.g. a still-
        // running agentrun) is re-fetched next cycle and can be
        // observed in its terminal state.
        if (eventRows.length > 0) {
            const last = eventRows[eventRows.length - 1];
            this.eventsAnchor = bumpDate(last.updatedAt);
        }
        if (runRows.length > 0) {
            const last = runRows[runRows.length - 1];
            this.agentrunsAnchor = bumpDate(last.updatedAt);
        }
        if (stepRows.length > 0) {
            const last = stepRows[stepRows.length - 1];
            this.stepresultsAnchor = bumpDate(last.createdAt);
        }
    }
}

function bumpDate(d: Date): Date {
    return new Date(d.getTime() + 1);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (signal) {
                signal.removeEventListener("abort", onAbort);
            }
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });
}
