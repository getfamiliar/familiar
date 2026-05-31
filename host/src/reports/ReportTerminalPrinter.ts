import {
    AgentRunBus,
    type AgentRunRow,
    type EventRow,
    type PostgresConnection,
    renderMarkdown,
    StepResultBus,
    type StepResultRow,
} from "@getfamiliar/shared";
import {
    type AgentrunAggregate,
    aggregateSteps,
    renderAgentrunResult,
    renderAgentrunStart,
    renderEventCreated,
    renderEventResult,
    renderStepResult,
} from "./Renderers.js";
import type { ReportSink } from "./ReportPoller.js";

/**
 * `ReportSink` that pretty-prints the same markdown sections to
 * stdout via `marked-terminal`. Used by `./cli.sh events tail` —
 * the operator runs it next to the daemon and watches sections
 * stream in as agentruns progress.
 *
 * Per-event de-duplication: the same agentrun/step is rendered at
 * most once per process lifetime even if the poller re-emits it
 * (e.g. after a state-change tick). Token aggregation happens here
 * on demand at terminal-state transitions.
 */
/**
 * Hook pair fired around every `process.stdout.write` the printer performs.
 * Used by `events tail` to stop/restart an `ora` spinner so its line stays
 * pinned to the bottom and doesn't get interleaved with the rendered
 * markdown sections.
 */
export interface WriteBoundary {
    readonly before: () => void;
    readonly after: () => void;
}

export class ReportTerminalPrinter implements ReportSink {
    private readonly agentruns: AgentRunBus;
    private readonly steps: StepResultBus;
    private readonly withDetails: boolean;
    private readonly onWriteBoundary: WriteBoundary | undefined;
    private readonly written = new Map<string, Set<string>>();

    constructor(
        connection: PostgresConnection,
        opts: {
            /**
             * When `true`, forward `withDetails` into the renderer
             * so the agentrun-start section includes the system
             * prompt (when one was logged via
             * `core.logSystemPrompt`). Defaults to `false` so the
             * live tail stays concise; surfaced as `--details` on
             * `events tail`.
             */
            withDetails?: boolean;
            /**
             * Optional pair of callbacks invoked immediately before
             * and after each stdout write. `events tail` uses this
             * to stop/restart an ora spinner around printer output.
             * Defaults to no-ops so other consumers are unaffected.
             */
            onWriteBoundary?: WriteBoundary;
        } = {},
    ) {
        this.agentruns = new AgentRunBus(connection);
        this.steps = new StepResultBus(connection);
        this.withDetails = opts.withDetails ?? false;
        this.onWriteBoundary = opts.onWriteBoundary;
    }

    async onEvent(row: EventRow, kind: "new" | "state-changed"): Promise<void> {
        const seen = this.trackerFor(row.id);
        if (kind === "new") {
            if (seen.has("event-created")) {
                return;
            }
            this.write(renderEventCreated(row));
            seen.add("event-created");
            return;
        }
        if (row.state !== "done" && row.state !== "failed") {
            return;
        }
        if (seen.has("event-result")) {
            return;
        }
        const runs = await this.agentruns.listByEventId(row.id);
        this.write(renderEventResult(row, runs));
        seen.add("event-result");
    }

    async onAgentrun(row: AgentRunRow, kind: "new" | "state-changed"): Promise<void> {
        const seen = this.trackerFor(row.eventId);
        if (kind === "new") {
            const key = `agentrun-start-${row.id}`;
            if (seen.has(key)) {
                return;
            }
            this.write(renderAgentrunStart(row, { withDetails: this.withDetails }));
            seen.add(key);
            return;
        }
        if (row.state !== "done" && row.state !== "failed") {
            return;
        }
        const key = `agentrun-result-${row.id}`;
        if (seen.has(key)) {
            return;
        }
        const aggregate = await this.aggregateForRun(row);
        this.write(renderAgentrunResult(row, aggregate));
        seen.add(key);
    }

    async onStepResult(row: StepResultRow): Promise<void> {
        const seen = this.trackerFor(row.eventId);
        const key = `step-${row.id}`;
        if (seen.has(key)) {
            return;
        }
        const run = await this.agentruns.getById(row.agentRunId);
        if (!run) {
            return;
        }
        this.write(renderStepResult(run, row));
        seen.add(key);
    }

    private async aggregateForRun(row: AgentRunRow): Promise<AgentrunAggregate> {
        const steps = await this.steps.listByAgentRunId(row.id);
        const sums = aggregateSteps(steps);
        return {
            ...sums,
            runtimeMs: Math.max(0, row.updatedAt.getTime() - row.createdAt.getTime()),
        };
    }

    private write(markdown: string): void {
        this.onWriteBoundary?.before();
        process.stdout.write(renderMarkdown(markdown));
        this.onWriteBoundary?.after();
    }

    private trackerFor(eventId: string): Set<string> {
        let set = this.written.get(eventId);
        if (!set) {
            set = new Set();
            this.written.set(eventId, set);
        }
        return set;
    }
}
