import { type AgentRunRow, renderMarkdown, type StepResultRow } from "@getfamiliar/shared";
import chalk from "chalk";
import ora, { type Ora } from "ora";

/**
 * One space of `prefixText` plus the space ora inserts before the
 * symbol gives the agentrun line a two-column indent, matching the
 * `↳` step lines below it. Kept here so the indent only lives in
 * one place.
 */
const SPINNER_PREFIX = " ";

/**
 * Encapsulates the per-turn output for the cli-chat REPL.
 *
 * Each agentrun is rendered as a single ora-managed block:
 *
 *   • `spinner.text`        — the live `agentrun #N …` status line
 *                              (with the X spinner symbol)
 *   • `spinner.suffixText`  — everything that should appear below
 *                              the agentrun line: `↳ step …` lines
 *                              and any chat-answer markdown that
 *                              arrived during the run.
 *
 * Because ora redraws the whole block with `log-update` on every
 * tick, the agentrun line stays anchored at the top while step
 * lines accumulate below — no more "the X jumped under the answer"
 * artefacts from stopping/restarting the spinner.
 *
 * State machine driven from the `events.emit` callbacks and the
 * chat subscription:
 *
 *   eventQueued(id)                    spinner starts
 *   agentRun(row) state=pending        spinner.text mutates
 *   agentRun(row) state=running        spinner.text mutates
 *   step(step) ×N                      suffix grows (gray)
 *   chatAnswer(text)                   suffix grows (markdown)
 *   agentRun(row) state=done|failed    spinner.succeed/fail
 *
 * When a *child* agentrun appears while the previous spinner is
 * still active, the previous spinner is succeeded first so the
 * operator sees the `√ agentrun #N …` checkmark, then a fresh
 * block starts below.
 */
/**
 * Factory the renderer uses to spawn a spinner. Production uses
 * {@link defaultSpinnerFactory} which wraps `ora()`; tests can inject
 * a stub to assert against `text` / `suffixText` mutations without
 * touching stdout.
 */
export type SpinnerFactory = (text: string) => Ora;

const defaultSpinnerFactory: SpinnerFactory = (text) =>
    ora({
        prefixText: SPINNER_PREFIX,
        text,
        color: "cyan",
        isEnabled: process.stdout.isTTY,
        interval: 250,
    }).start();

export class RunRenderer {
    private spinner: Ora | undefined;
    private readonly isTty: boolean;
    private readonly spinnerFactory: SpinnerFactory;
    /** Per-agentrun bookkeeping so onAgentRun can decide insert-vs-update. */
    private readonly seenRuns = new Map<string, AgentRunRow>();
    /** id of the agentrun currently driving the spinner, if any. */
    private currentRunId: string | undefined;
    /**
     * Accumulated lines for the active spinner's `suffixText`. Stored
     * separately from the spinner so step / chat callbacks can append
     * without re-reading the rendered output.
     */
    private suffixLines: string[] = [];

    constructor(isTty: boolean, spinnerFactory: SpinnerFactory = defaultSpinnerFactory) {
        this.isTty = isTty;
        this.spinnerFactory = spinnerFactory;
    }

    /**
     * Step 1: the user line has been submitted; we have an event id
     * but no agentrun yet. Start the spinner with the "queued"
     * message and reset the suffix accumulator.
     *
     * Race note: `ctx.events.emit` registers the `onAgentRun`
     * subscriber **before** it awaits the INSERT, so a fast container
     * can already fire `agentRun(...)` here before this method runs.
     * If that happened, a spinner already exists with the more-
     * specific agentrun text — don't overwrite it with the less
     * informative "queued as event" message (and don't create a
     * second ora that fights the first for `log-update`).
     */
    eventQueued(eventId: string): void {
        if (this.spinner !== undefined) {
            return;
        }
        this.suffixLines = [];
        this.spinner = this.startSpinner(statusLine(`message queued as event #${eventId}`));
    }

    /**
     * Fired by `events.emit({ onAgentRun })`. Routes the row to the
     * right phase based on its state and whether we've seen it before.
     */
    agentRun(row: AgentRunRow): void {
        const previous = this.seenRuns.get(row.id);
        this.seenRuns.set(row.id, row);
        if (!previous) {
            this.handleInserted(row);
            return;
        }
        if (row.state === "running" && previous.state !== "running") {
            this.handleRunning(row);
            return;
        }
        if (row.state === "done" || row.state === "failed") {
            this.handleSettled(row);
        }
    }

    /**
     * Fired by `events.emit({ onStep })`. Appends gray `↳` lines to
     * the active spinner's suffix so they appear permanently below
     * the agentrun status line. Empty results (see
     * {@link formatStepLines}) are silently dropped.
     */
    step(step: StepResultRow): void {
        const lines = formatStepLines(step);
        if (lines.length === 0) {
            return;
        }
        for (const line of lines) {
            this.suffixLines.push(chalk.gray(line));
        }
        this.refreshSuffix();
    }

    /**
     * Fired by `ctx.chat.subscribe`. Renders markdown into the
     * spinner's suffix preceded by a blank line so it stands apart
     * from the `↳` block. Without an active spinner (turn already
     * settled) the body prints to stdout directly.
     *
     * Surrounding blank lines are stripped before rendering — models
     * routinely pad their messages with `\n` (sometimes several) and we
     * want full control over the blank-line layout around the answer.
     * Only whole leading/trailing blank lines and trailing spaces are
     * removed; the first content line's leading indentation is preserved
     * so an indented code block stays a code block (a plain `.trim()`
     * would strip the first line's indent and collapse it into a lazy
     * paragraph).
     */
    chatAnswer(textContent: string): void {
        const trimmed = textContent.replace(/^(?:[^\S\n]*\n)+/u, "").replace(/\s+$/u, "");
        if (trimmed.length === 0) {
            return;
        }
        const rendered = this.isTty ? renderMarkdown(trimmed) : trimmed;
        const body = rendered.replace(/\s+$/u, "");
        if (!this.spinner) {
            process.stdout.write(`\n${body}\n\n`);
            return;
        }
        // Trailing "" leaves one blank line between the rendered
        // answer and whatever comes next (the next prompt, or a
        // follow-up agentrun's status line).
        this.suffixLines.push("", body, "");
        this.refreshSuffix();
    }

    /**
     * Final defensive write. If `handle.settled` resolved before any
     * `agentRunSettled` came through (e.g. the agentrun was orphaned
     * server-side), succeed whatever's still spinning so the line
     * doesn't hang animated.
     */
    done(): void {
        if (this.spinner?.isSpinning) {
            this.persistAsSucceeded();
        }
        this.spinner = undefined;
        this.currentRunId = undefined;
        this.suffixLines = [];
    }

    /** Mark the active spinner as failed with the supplied message. */
    failed(message: string): void {
        if (this.spinner) {
            this.persistAsFailed(message);
            this.spinner = undefined;
        } else if (this.isTty) {
            process.stdout.write(`✖  ${message}\n`);
        } else {
            process.stdout.write(`[error] ${message}\n`);
        }
        this.currentRunId = undefined;
        this.suffixLines = [];
    }

    /** Quietly tear the spinner down — used on Ctrl-C abort. */
    stop(): void {
        if (this.spinner) {
            this.spinner.stop();
            this.spinner = undefined;
        }
        this.currentRunId = undefined;
        this.suffixLines = [];
    }

    private handleInserted(row: AgentRunRow): void {
        // First agentrun for the event: reuse the spinner started
        // by eventQueued. Its text becomes the new agentrun status.
        if (this.currentRunId === undefined && this.spinner) {
            this.spinner.text = statusLine(`agentrun #${row.id} ${this.queuedSuffix(row)}`);
            this.currentRunId = row.id;
            return;
        }
        // Different agentrun id while another is still active —
        // succeed the previous block so the operator sees `√` and
        // start a fresh spinner for the child.
        if (this.currentRunId !== row.id) {
            if (this.spinner) {
                this.persistAsSucceeded();
            }
            this.suffixLines = [];
            this.spinner = this.startSpinner(
                statusLine(`agentrun #${row.id} ${this.queuedSuffix(row)}`),
            );
            this.currentRunId = row.id;
        }
    }

    private handleRunning(row: AgentRunRow): void {
        if (this.currentRunId === row.id && this.spinner) {
            this.spinner.text = statusLine(`agentrun #${row.id} ${this.runningSuffix(row)}`);
        }
    }

    private handleSettled(row: AgentRunRow): void {
        if (this.currentRunId !== row.id || !this.spinner) {
            return;
        }
        if (row.state === "failed") {
            this.persistAsFailed();
        } else {
            this.persistAsSucceeded();
        }
        this.spinner = undefined;
        this.currentRunId = undefined;
        this.suffixLines = [];
    }

    /**
     * Replace the active spinner with a green check followed by **two
     * spaces** before the text. Ora's default `succeed()` lays out
     * `<symbol> <text>` with a single space; appending the extra
     * space inside the symbol keeps `✔` from butting up against the
     * narrower-than-spinner-frame next character.
     */
    private persistAsSucceeded(): void {
        if (!this.spinner) {
            return;
        }
        this.spinner.stopAndPersist({ symbol: `${chalk.green("✔")} ` });
    }

    /** Same shape as {@link persistAsSucceeded} for the failure path. */
    private persistAsFailed(textOverride?: string): void {
        if (!this.spinner) {
            return;
        }
        this.spinner.stopAndPersist({
            symbol: `${chalk.red("✖")} `,
            text: textOverride ?? this.spinner.text,
        });
    }

    /**
     * Suffix for the `agentrun #X …` spinner text while the row is
     * still `pending` (model is not set yet). Distinguishes root
     * agentruns (`for event #Y`) from spawned child runs (carries
     * the handler path instead).
     */
    private queuedSuffix(row: AgentRunRow): string {
        if (row.parentAgentrunId === null) {
            return `queued for event #${row.eventId}`;
        }
        return `with handler \`${handlerPath(row)}\` queued for event #${row.eventId}`;
    }

    /**
     * Suffix for the `agentrun #X …` spinner text once the row has
     * transitioned to `running`. The `model` column is written by
     * the AgentRunner *after* the state flip to `running`, and the
     * trigger only fires on `state` UPDATEs — so by the time we see
     * the running NOTIFY the model is still null. Surfacing it here
     * would always read "(model TBD)", which is just noise; the
     * field is omitted entirely.
     */
    private runningSuffix(row: AgentRunRow): string {
        if (row.parentAgentrunId === null) {
            return `started for event #${row.eventId}`;
        }
        const promptExcerpt = excerpt(row.prompt ?? "", 80);
        return `with handler \`${handlerPath(row)}\` started: "${promptExcerpt}"`;
    }

    /**
     * Start a fresh spinner via the injected {@link SpinnerFactory}.
     * The production factory configures ora with our two-column
     * prefix indent, cyan colour, `isEnabled: process.stdout.isTTY`,
     * and a 250 ms `interval` (slower than ora's default 80 ms so
     * WSL/Windows Terminal doesn't flicker on multi-line log-update
     * redraws).
     */
    private startSpinner(text: string): Ora {
        return this.spinnerFactory(text);
    }

    /** Push the current suffix-lines buffer into the active spinner. */
    private refreshSuffix(): void {
        if (!this.spinner) {
            return;
        }
        this.spinner.suffixText = `\n${this.suffixLines.join("\n")}`;
    }
}

/**
 * Wrap the event / agentrun status line in dim gray so the whole
 * "thinking block" — the agentrun status, the `↳` step lines, and
 * the chat-answer markdown — reads as one visual unit. The leading
 * spinner symbol stays in its native colour (cyan while spinning,
 * green ✔ on success, red ✖ on failure).
 */
function statusLine(text: string): string {
    return chalk.gray(text);
}

/**
 * Workspace-relative handler path string for display purposes, e.g.
 * `chat/scheduler.md`. We don't have the leaf's actual filesystem
 * path on the row, only the topic + handler basename; rebuild a
 * canonical form so the output is consistent with the input syntax.
 */
function handlerPath(row: AgentRunRow): string {
    const segments = row.topic.split(":");
    return `${segments.join("/")}/${row.handler}.md`;
}

/**
 * Format a {@link StepResultRow} as the permanent `↳` line(s).
 *
 * Skip rules (to keep the output signal-dense):
 * - `finish_reason: 'stop'` with no reasoning text → nothing. The
 *   assistant's final answer is already rendered as the chat
 *   response; a `↳ N. ""` line would just be noise.
 * - tool-calls step with no reasoning and no result text → the
 *   placeholder head is replaced by the tool list inline, so the
 *   user gets `↳ N. tool_calls: …` on a single line instead of
 *   the two-line `↳ N. <finish_reason>` + `tool_calls: …`.
 *
 * Otherwise: reasoning > result text > finish reason for the head,
 * with an optional `tool_calls: …` continuation line on its own.
 */
export function formatStepLines(step: StepResultRow): string[] {
    const reasoning = step.reasoningText?.trim();
    const text = step.resultText?.trim();
    const toolNames = extractToolNames(step.toolCalls);
    const stepNo = step.stepNumber + 1;

    const hasReasoning = reasoning !== undefined && reasoning.length > 0;
    const hasText = text !== undefined && text.length > 0;

    if (!hasReasoning && step.finishReason === "stop") {
        return [];
    }

    if (!hasReasoning && !hasText && toolNames.length > 0) {
        return [`  ↳ ${stepNo}. tool_calls: ${toolNames.join(", ")}`];
    }

    const head = hasReasoning
        ? `"${excerpt(reasoning, 120)}"`
        : hasText
          ? `"${excerpt(text, 120)}"`
          : step.finishReason;

    const lines = [`  ↳ ${stepNo}. ${head}`];
    if (toolNames.length > 0) {
        lines.push(`       tool_calls: ${toolNames.join(", ")}`);
    }
    return lines;
}

function extractToolNames(toolCalls: unknown): string[] {
    if (!Array.isArray(toolCalls)) {
        return [];
    }
    const names: string[] = [];
    for (const tc of toolCalls) {
        if (tc && typeof tc === "object") {
            const name = (tc as { toolName?: unknown }).toolName;
            if (typeof name === "string") {
                names.push(name);
            }
        }
    }
    return names;
}

function excerpt(s: string, max: number): string {
    const collapsed = s.trim().replace(/\s+/g, " ");
    if (collapsed.length <= max) {
        return collapsed;
    }
    return `${collapsed.slice(0, Math.max(1, max - 1))}…`;
}
