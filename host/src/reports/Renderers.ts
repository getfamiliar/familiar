import type { AgentRunRow, EventRow, StepResultRow } from "@getfamiliar/shared";

/**
 * Pure markdown renderers used by `report tail` (live streaming via
 * {@link ReportTerminalPrinter}) and `report event <id>` (one-shot
 * render from the bus tables). No I/O, no logger, no DB lookups —
 * every piece of data the renderer needs comes via its arguments.
 * That makes the output deterministic and the renderers trivially
 * testable.
 *
 * Formatting rule: JSON values (event/agentrun payloads, tool call
 * inputs and outputs) render as fenced ```json code blocks; prose
 * (prompts, result text, error text, reasoning) renders as
 * blockquotes. The terminal renderer (`marked-terminal`) styles
 * code blocks differently — sometimes mangling unfamiliar words
 * inside prose — so we keep prose out of the code-block path.
 *
 * Long string values inside payloads / tool I/O are truncated at
 * {@link MAX_STRING_CHARS} characters via {@link truncateJson},
 * which walks the value tree and trims leaf strings only — JSON
 * structure stays well-formed so the rendered code blocks remain
 * readable. Reasoning text and prompts are rendered in full.
 */

/**
 * Per-string truncation cap. The cap applies to *individual string
 * values* inside a JSON structure — not to the serialized output as
 * a whole. Truncating the JSON string would explode the format
 * (unbalanced braces, dangling commas); walking the value tree and
 * trimming only the leaf strings keeps the JSON well-formed and
 * still readable.
 */
export const MAX_STRING_CHARS = 512;

/**
 * Pretty-print a value as JSON with every leaf string truncated at
 * `max` characters. Arrays, objects, numbers, booleans, and `null`
 * pass through unchanged so the structure is always parseable.
 */
export function truncateJson(value: unknown, max: number = MAX_STRING_CHARS): string {
    try {
        const trimmed = truncateStringsDeep(value, max);
        return JSON.stringify(trimmed, null, 2) ?? String(trimmed);
    } catch {
        return String(value);
    }
}

/**
 * Walk a value tree and return a structurally-equivalent copy with
 * every leaf string truncated at `max` characters. Strings longer
 * than the cap get an ellipsis appended; arrays and objects recurse
 * into their elements; primitives pass through.
 */
function truncateStringsDeep(value: unknown, max: number): unknown {
    if (typeof value === "string") {
        return value.length > max ? `${value.slice(0, max)}…` : value;
    }
    if (Array.isArray(value)) {
        return value.map((v) => truncateStringsDeep(v, max));
    }
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = truncateStringsDeep(v, max);
        }
        return out;
    }
    return value;
}

/** Render the event-created section — H1 + metadata table + prompt + payload. */
export function renderEventCreated(event: EventRow): string {
    const lines: string[] = [];
    lines.push(`# Event #${event.id} (created ${formatTs(event.createdAt)})`);
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("| --- | --- |");
    lines.push(`| Topic | \`${event.topic}\` |`);
    lines.push(`| Chat Message | ${event.isChat ? "yes" : "no"} |`);
    lines.push(`| Privileged | ${event.privileged ? "yes" : "no"} |`);
    lines.push(`| Priority | ${event.priority} |`);
    lines.push(`| Idempotency Key | ${event.idempotencyKey ?? "—"} |`);
    lines.push(`| Preferred Chat Channel | ${event.preferredChatChannelId ?? "—"} |`);
    lines.push(`| Start Handler | ${event.startHandler ?? "<default>"} |`);
    lines.push("");
    if (event.prompt && event.prompt.length > 0) {
        lines.push("**Prompt:**");
        lines.push("");
        pushBlockquote(lines, event.prompt);
        lines.push("");
    }
    if (hasContent(event.payload)) {
        lines.push("**Payload:**");
        lines.push("");
        lines.push("```json");
        lines.push(truncateJson(event.payload));
        lines.push("```");
        lines.push("");
    }
    return joinSection(lines);
}

/** Options controlling per-section verbosity in the agentrun-start renderer. */
export interface AgentrunStartOptions {
    /**
     * When `true`, append the resolved system prompt as a code
     * block. Off by default — system prompts are several KB and
     * only useful while debugging. Requires `core.logSystemPrompt`
     * to also be on; otherwise `run.systemPrompt` is `null` and
     * the section is silently omitted.
     */
    readonly withDetails?: boolean;
}

/**
 * Render the agentrun-start section — H2 + start-time metadata +
 * prompt + payload. When `options.withDetails` and
 * `run.systemPrompt` is non-empty, the section also includes a
 * `**System Prompt:**` block.
 *
 * Root agentruns (parentAgentrunId === null) inherit prompt and
 * payload verbatim from the originating event, so we omit those
 * sections and surface a one-line note instead — the data is
 * already in the Event Created section above.
 */
export function renderAgentrunStart(run: AgentRunRow, options: AgentrunStartOptions = {}): string {
    const lines: string[] = [];
    const isRoot = run.parentAgentrunId === null;
    lines.push(`## Agentrun Start: #${run.id}`);
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("| --- | --- |");
    lines.push(`| Handler | \`${run.topic}/${run.handler}\` |`);
    lines.push(`| Model | ${run.model ?? "—"} |`);
    lines.push(`| Parent Agentrun | ${run.parentAgentrunId ?? "—"} |`);
    if (run.calltype !== null) {
        lines.push(`| Call Type | ${run.calltype} |`);
    }
    if (run.retryCount > 0) {
        lines.push(`| Retry Count | ${run.retryCount} |`);
    }
    lines.push("");
    if (isRoot) {
        lines.push("_Prompt and payload inherited from the event._");
        lines.push("");
    } else {
        if (run.prompt && run.prompt.length > 0) {
            lines.push("**Prompt:**");
            lines.push("");
            pushBlockquote(lines, run.prompt);
            lines.push("");
        }
        if (hasContent(run.payload)) {
            lines.push("**Payload:**");
            lines.push("");
            lines.push("```json");
            lines.push(truncateJson(run.payload));
            lines.push("```");
            lines.push("");
        }
    }
    if (options.withDetails === true && run.systemPrompt && run.systemPrompt.length > 0) {
        // Untruncated; if the operator opted into withDetails they
        // accepted the verbosity. Same blockquote posture as
        // reasoningText since the system prompt is prose-ish.
        lines.push("**System Prompt:**");
        lines.push("");
        pushBlockquote(lines, run.systemPrompt);
        lines.push("");
    }
    return joinSection(lines);
}

/**
 * Render one step — H3 + token table + reasoning + result text +
 * tool-call/result code blocks. `run` is needed for the H3 heading
 * (which carries `Agentrun #<id>`); the renderer pulls everything
 * else from the step row directly.
 */
export function renderStepResult(run: AgentRunRow, step: StepResultRow): string {
    const lines: string[] = [];
    lines.push(`### Agentrun #${run.id} — Step ${step.stepNumber} (${step.finishReason})`);
    lines.push("");
    pushTokenTable(lines, {
        inputTokens: step.inputTokens,
        outputTokens: step.outputTokens,
        totalTokens: step.totalTokens,
        inputTokensNoCache: step.inputTokensNoCache,
        inputTokensCacheRead: step.inputTokensCacheRead,
        outputTokensText: step.outputTokensText,
        outputTokensReasoning: step.outputTokensReasoning,
    });
    lines.push("");
    if (step.reasoningText && step.reasoningText.length > 0) {
        // Reasoning text is rendered in full — no truncation.
        lines.push("**Thinking:**");
        lines.push("");
        pushBlockquote(lines, step.reasoningText);
        lines.push("");
    }
    if (step.resultText && step.resultText.length > 0) {
        lines.push("**Result:**");
        lines.push("");
        pushBlockquote(lines, step.resultText);
        lines.push("");
    }

    const calls = asArray(step.toolCalls);
    const results = asArray(step.toolResults);
    if (calls.length > 0) {
        for (const call of calls) {
            const id = (call as { toolCallId?: string }).toolCallId;
            const name = (call as { toolName?: string }).toolName ?? "<unknown>";
            const input = (call as { input?: unknown }).input;
            const match = id
                ? results.find((r) => (r as { toolCallId?: string }).toolCallId === id)
                : undefined;
            lines.push(`**Tool call:** \`${name}\``);
            lines.push("");
            lines.push("```json");
            lines.push(truncateJson(input));
            lines.push("```");
            lines.push("");
            lines.push("→");
            lines.push("");
            if (match && (match as { type?: string }).type === "tool-error") {
                const errorText = (match as { error?: unknown }).error;
                pushBlockquote(lines, asErrorText(errorText));
                lines.push("");
            } else {
                const output = match ? (match as { output?: unknown }).output : undefined;
                lines.push("```json");
                lines.push(truncateJson(output));
                lines.push("```");
                lines.push("");
            }
        }
    }
    return joinSection(lines);
}

/**
 * Coerce a persisted `tool-error.error` field to a renderable string.
 * `AgentRunner` already flattens errors to `<code>: <message>` strings
 * before persisting, but older rows (or future SDK changes) may carry
 * other shapes — handle them defensively.
 */
function asErrorText(value: unknown): string {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    if (value === undefined || value === null) {
        return "tool error";
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/**
 * Render the agentrun-result section — H2 + state/runtime table +
 * compact 3-row token summary + either error or `result_text`.
 * Token totals come from `aggregate` (already summed across the
 * run's steps); the renderer stays DB-free.
 */
export function renderAgentrunResult(run: AgentRunRow, aggregate: AgentrunAggregate): string {
    const lines: string[] = [];
    lines.push(`## Agentrun Results: #${run.id}`);
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("| --- | --- |");
    lines.push(`| State | ${run.state} |`);
    lines.push(`| Steps | ${aggregate.stepCount} |`);
    lines.push(`| Runtime | ${formatDurationMs(aggregate.runtimeMs)} |`);
    lines.push("");
    pushTokenTable(lines, {
        inputTokens: aggregate.totalInputTokens,
        outputTokens: aggregate.totalOutputTokens,
        totalTokens: aggregate.totalInputTokens + aggregate.totalOutputTokens,
        inputTokensNoCache: nullIfZero(aggregate.totalInputTokensNoCache),
        inputTokensCacheRead: nullIfZero(aggregate.totalInputTokensCacheRead),
        outputTokensText: nullIfZero(aggregate.totalOutputTokensText),
        outputTokensReasoning: nullIfZero(aggregate.totalOutputTokensReasoning),
    });
    lines.push("");
    if (run.error) {
        lines.push("**Error:**");
        lines.push("");
        pushBlockquote(lines, run.error);
        lines.push("");
    } else if (run.resultText && run.resultText.length > 0) {
        lines.push("**Result:**");
        lines.push("");
        pushBlockquote(lines, run.resultText);
        lines.push("");
    }
    return joinSection(lines);
}

/**
 * Render the final event-result summary — H2 with totals across every
 * agentrun belonging to the event, then either the root agentrun's
 * `result_text` or the collected error texts.
 */
export function renderEventResult(event: EventRow, runs: readonly AgentRunRow[]): string {
    const lines: string[] = [];
    lines.push(`## Event Result: #${event.id}`);
    lines.push("");
    const totalRuntime = runs.reduce(
        (acc, r) => acc + Math.max(0, r.updatedAt.getTime() - r.createdAt.getTime()),
        0,
    );
    lines.push("| Field | Value |");
    lines.push("| --- | --- |");
    lines.push(`| State | ${event.state} |`);
    lines.push(`| Agentruns | ${runs.length} |`);
    lines.push(`| Total Runtime | ${formatDurationMs(totalRuntime)} |`);
    lines.push("");
    const errors = runs.map((r) => r.error).filter((e): e is string => !!e);
    if (errors.length > 0) {
        lines.push("**Errors:**");
        lines.push("");
        for (const e of errors) {
            pushBlockquote(lines, e);
            lines.push("");
        }
    } else {
        const root = runs.find((r) => r.parentAgentrunId === null);
        if (root?.resultText && root.resultText.length > 0) {
            lines.push("**Final Result:**");
            lines.push("");
            pushBlockquote(lines, root.resultText);
            lines.push("");
        }
    }
    return joinSection(lines);
}

/**
 * Marker appended when the file writer reopens an existing event
 * file after a daemon restart. Surfaces the discontinuity so a
 * reader doesn't mistake duplicate sections for normal flow.
 */
export function renderRestartMarker(): string {
    return "> _(daemon restarted, continuing from here)_\n\n";
}

/** Pre-aggregated per-agentrun stats fed to {@link renderAgentrunResult}. */
export interface AgentrunAggregate {
    readonly stepCount: number;
    readonly totalInputTokens: number;
    readonly totalOutputTokens: number;
    readonly totalInputTokensNoCache: number;
    readonly totalInputTokensCacheRead: number;
    readonly totalOutputTokensText: number;
    readonly totalOutputTokensReasoning: number;
    readonly runtimeMs: number;
}

/** Sum a readonly StepResultRow array into the aggregate the renderer wants. */
export function aggregateSteps(steps: readonly StepResultRow[]): {
    stepCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalInputTokensNoCache: number;
    totalInputTokensCacheRead: number;
    totalOutputTokensText: number;
    totalOutputTokensReasoning: number;
} {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalInputTokensNoCache = 0;
    let totalInputTokensCacheRead = 0;
    let totalOutputTokensText = 0;
    let totalOutputTokensReasoning = 0;
    for (const s of steps) {
        totalInputTokens += s.inputTokens ?? 0;
        totalOutputTokens += s.outputTokens ?? 0;
        totalInputTokensNoCache += s.inputTokensNoCache ?? 0;
        totalInputTokensCacheRead += s.inputTokensCacheRead ?? 0;
        totalOutputTokensText += s.outputTokensText ?? 0;
        totalOutputTokensReasoning += s.outputTokensReasoning ?? 0;
    }
    return {
        stepCount: steps.length,
        totalInputTokens,
        totalOutputTokens,
        totalInputTokensNoCache,
        totalInputTokensCacheRead,
        totalOutputTokensText,
        totalOutputTokensReasoning,
    };
}

/**
 * Push the compact 3-row token table into `lines`. Output shape:
 *
 * ```
 * | Tokens | Count                              |
 * | --- | --- |
 * | Input | <total> (x no cache, y cache read) |
 * | Output | <total> (x text, y reasoning)      |
 * | Total | <total>                            |
 * ```
 *
 * The breakdown parens are added only when at least one of the
 * detail columns is non-null, so providers that don't report the
 * split degrade gracefully to a bare total.
 */
function pushTokenTable(
    lines: string[],
    usage: {
        readonly inputTokens: number | null;
        readonly outputTokens: number | null;
        readonly totalTokens: number | null;
        readonly inputTokensNoCache: number | null;
        readonly inputTokensCacheRead: number | null;
        readonly outputTokensText: number | null;
        readonly outputTokensReasoning: number | null;
    },
): void {
    lines.push("| Tokens | Count |");
    lines.push("| --- | --- |");
    lines.push(`| Input | ${formatInputCell(usage)} |`);
    lines.push(`| Output | ${formatOutputCell(usage)} |`);
    lines.push(`| Total | ${nullableNumber(usage.totalTokens)} |`);
}

function formatInputCell(usage: {
    readonly inputTokens: number | null;
    readonly inputTokensNoCache: number | null;
    readonly inputTokensCacheRead: number | null;
}): string {
    const total = nullableNumber(usage.inputTokens);
    const breakdown: string[] = [];
    if (usage.inputTokensNoCache !== null) {
        breakdown.push(`${usage.inputTokensNoCache} no cache`);
    }
    if (usage.inputTokensCacheRead !== null) {
        breakdown.push(`${usage.inputTokensCacheRead} cache read`);
    }
    return breakdown.length > 0 ? `${total} (${breakdown.join(", ")})` : total;
}

function formatOutputCell(usage: {
    readonly outputTokens: number | null;
    readonly outputTokensText: number | null;
    readonly outputTokensReasoning: number | null;
}): string {
    const total = nullableNumber(usage.outputTokens);
    const breakdown: string[] = [];
    if (usage.outputTokensText !== null) {
        breakdown.push(`${usage.outputTokensText} text`);
    }
    if (usage.outputTokensReasoning !== null) {
        breakdown.push(`${usage.outputTokensReasoning} reasoning`);
    }
    return breakdown.length > 0 ? `${total} (${breakdown.join(", ")})` : total;
}

/**
 * Convert summed-across-steps `0` back to `null` for the run-level
 * token table. A run that had no cache hits still reports
 * `totalInputTokensCacheRead = 0`; we don't want a `(0 cache read)`
 * line cluttering the output, so coerce zeros to "unreported".
 */
function nullIfZero(n: number): number | null {
    return n === 0 ? null : n;
}

/** Append a multi-line value as a markdown blockquote — `> ` prefix per line. */
function pushBlockquote(lines: string[], text: string): void {
    for (const line of text.split("\n")) {
        lines.push(`> ${line}`);
    }
}

function formatTs(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDurationMs(ms: number): string {
    if (ms < 1000) {
        return `${ms} ms`;
    }
    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)} s`;
    }
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
}

function nullableNumber(v: number | null): string {
    return v === null ? "—" : String(v);
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function hasContent(value: unknown): boolean {
    if (value === null || value === undefined) {
        return false;
    }
    if (typeof value === "object" && Object.keys(value as object).length === 0) {
        return false;
    }
    return true;
}

/** Trim trailing blank lines and ensure exactly one newline at the end. */
function joinSection(lines: string[]): string {
    while (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return `${lines.join("\n")}\n\n`;
}
