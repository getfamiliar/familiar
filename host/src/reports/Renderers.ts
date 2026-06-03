import type { AgentRunRow, EventRow, StepResultRow } from "@getfamiliar/shared";

/**
 * Pure, DB-free renderer for an event's agentrun tree as a single
 * hierarchical markdown document. Consumed by `events report <id>`
 * (CLI) and the `event_report` / `agentrun_report` reflection tools.
 * Every piece of data comes via arguments — the caller pre-fetches all
 * agentruns for the event plus a `agentRunId → steps[]` map — so the
 * output is deterministic and the renderer trivially testable.
 *
 * Shape: the event header (fields table + prompt + payload), then the
 * root agentrun's block (handler/model line, optional system prompt and
 * initial message history, the numbered Step Protocol), then the final
 * result. Each subagent a step spawned (`call_handler` /
 * `schedule_handler`) is rendered inline as a markdown blockquote right
 * after the spawning step; nesting recurses (a grandchild's lines are
 * blockquote-prefixed twice → `> > `).
 *
 * Formatting rule (unchanged from the old section renderers): JSON
 * values render in fenced code blocks; prose (prompts, results, errors,
 * reasoning) renders as blockquotes, keeping prose out of the
 * code-block path that `marked-terminal` styles differently.
 */

/** Per-string truncation cap when `truncate` is on (JSON leaf strings). */
const TRUNCATE_STRING_CHARS = 128;
/** Per-prose truncation cap when `truncate` is on (prompts, results, reasoning). */
const TRUNCATE_PROSE_CHARS = 256;
/** Idempotency-key cell is bounded to this many characters in the event table. */
const IDEMPOTENCY_KEY_PREVIEW_CHARS = 100;

/**
 * Detail level, climbing with each `-v`:
 *   0 — fields, step protocol (thinking + tool-call names / `stop`), result.
 *   1 — also per-step token suffix and the resolved system prompt.
 *   2 — also full tool-call I/O blocks and the initial message history.
 */
export type VerbosityLevel = 0 | 1 | 2;

/**
 * Orthogonal render knobs. `verbosity` selects which sections appear;
 * `truncate` independently caps long prose / JSON so an agent-facing
 * report stays bounded in another run's context. The CLI passes
 * `truncate: false` (full text); the reflection tools default it to
 * `true`.
 */
export interface RenderOptions {
    readonly verbosity: VerbosityLevel;
    readonly truncate: boolean;
}

/** Internal render context — the indexed tree plus the active options. */
interface RenderCtx {
    /** All children of an agentrun, keyed by parent id, id-sorted. */
    readonly childrenByParent: Map<string, AgentRunRow[]>;
    /** Steps for an agentrun, keyed by agentrun id, in step order. */
    readonly stepsByRun: Map<string, readonly StepResultRow[]>;
    readonly opts: RenderOptions;
}

/** How the current agentrun block is positioned in the document. */
interface BlockRole {
    /** `true` when blockquote-nested under a parent step; `false` at the document root. */
    readonly nested: boolean;
    /** Heading noun — `"Root agentrun"` for an event's root, else `"Agentrun"`. */
    readonly label: string;
}

/** An item rendered inline after a step: a spawned child or a deferred schedule. */
type StepAttachment =
    | { readonly kind: "child"; readonly child: AgentRunRow }
    | {
          readonly kind: "scheduled";
          readonly topic: string | undefined;
          readonly handler: string;
          readonly when: string;
      };

/**
 * Render the full hierarchical report for one event: header + the root
 * agentrun's block (with all descendants nested inline) + final result.
 *
 * @param event The originating event row.
 * @param runs Every agentrun in the event's tree (root + descendants).
 * @param stepsByRun Steps per agentrun id, in step order.
 * @param opts Verbosity and truncation knobs.
 * @returns The rendered markdown document (trailing newline included).
 */
export function renderEventReport(
    event: EventRow,
    runs: readonly AgentRunRow[],
    stepsByRun: Map<string, readonly StepResultRow[]>,
    opts: RenderOptions,
): string {
    const ctx = buildCtx(runs, stepsByRun, opts);
    const lines: string[] = [];

    lines.push(`# Event #${event.id} (created ${formatTs(event.createdAt)})`);
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("| --- | --- |");
    lines.push(`| Topic | \`${event.topic}\` |`);
    lines.push(`| Start Handler | ${event.startHandler ?? "<default>"} |`);
    lines.push(`| Output is Chat Message | ${event.isChat ? "yes" : "no"} |`);
    lines.push(`| Preferred Chat Channel | ${event.preferredChatChannelId ?? "—"} |`);
    lines.push(`| Privileged | ${event.privileged ? "yes" : "no"} |`);
    lines.push(`| Priority | ${event.priority} |`);
    lines.push(`| Idempotency Key | ${idempotencyKeyCell(event.idempotencyKey)} |`);
    lines.push(`| State | ${capitalize(event.state)} |`);
    lines.push("");
    if (event.prompt && event.prompt.length > 0) {
        lines.push("**Prompt:**");
        lines.push("");
        pushBlockquote(lines, trimProse(event.prompt, opts));
        lines.push("");
    }
    if (hasContent(event.payload)) {
        lines.push("**Payload:**");
        lines.push("");
        lines.push("```json");
        lines.push(jsonBlock(event.payload, opts));
        lines.push("```");
        lines.push("");
    }

    // Usually exactly one root; loop defensively in case an event ever
    // has more than one parent-less agentrun.
    const roots = runs.filter((r) => r.parentAgentrunId === null);
    for (const root of roots) {
        lines.push(...renderAgentrunBlock(root, ctx, { nested: false, label: "Root agentrun" }));
    }

    // For a settled event, close with the token total summed across every
    // agentrun in the tree — sits just below the root's Final Result.
    if (event.state === "done" || event.state === "failed") {
        const t = sumEventTokens(stepsByRun);
        const parts = tokenBreakdown(t);
        if (t.total || parts.length > 0) {
            lines.push("");
            lines.push(
                parts.length > 0
                    ? `**Tokens used across the event:** ${t.total} (${parts.join(" + ")})`
                    : `**Tokens used across the event:** ${t.total}`,
            );
        }
    }

    return joinDocument(lines);
}

/**
 * Render one agentrun (and its descendants) as a standalone document —
 * no event header. Used by the `agentrun_report` reflection tool.
 *
 * @param root The agentrun to render as the document root.
 * @param runs `root` plus all its descendants (e.g. the event's full
 *   tree; non-descendants are simply never reached).
 * @param stepsByRun Steps per agentrun id, in step order.
 * @param opts Verbosity and truncation knobs.
 * @returns The rendered markdown document (trailing newline included).
 */
export function renderAgentrunReport(
    root: AgentRunRow,
    runs: readonly AgentRunRow[],
    stepsByRun: Map<string, readonly StepResultRow[]>,
    opts: RenderOptions,
): string {
    const ctx = buildCtx(runs, stepsByRun, opts);
    return joinDocument(renderAgentrunBlock(root, ctx, { nested: false, label: "Agentrun" }));
}

/**
 * Render one agentrun block as unprefixed markdown lines: heading,
 * handler/model line, optional system prompt (`-v`) and initial message
 * history (`-vv`), the Step Protocol with descendants spliced in, and —
 * for a top-level block — the final result. Recurses into children via
 * {@link prefixBlockquote}.
 */
function renderAgentrunBlock(run: AgentRunRow, ctx: RenderCtx, role: BlockRole): string[] {
    const lines: string[] = [];
    const heading = role.nested ? "###" : "##";

    // A pending child hasn't run yet: render a one-line stub (and stop —
    // it has no steps and no descendants to recurse into).
    if (run.state === "pending") {
        const status = run.notBefore
            ? `wakeup at ${formatTs(run.notBefore)}`
            : "queued for execution";
        lines.push(`${heading} ${role.label} #${run.id} (${status})`);
        return lines;
    }

    lines.push(`${heading} ${role.label} #${run.id} (started ${formatTs(run.createdAt)})`);
    lines.push("");
    lines.push(
        `Using handler \`${run.topic}/${run.handler}\` with model ${
            run.model ? `\`${run.model}\`` : "`—`"
        }.`,
    );
    lines.push("");

    if (ctx.opts.verbosity >= 1 && run.systemPrompt && run.systemPrompt.length > 0) {
        lines.push("**System Prompt:**");
        lines.push("");
        pushBlockquote(lines, run.systemPrompt);
        lines.push("");
    }

    if (ctx.opts.verbosity >= 2) {
        lines.push("**Initial message history:**");
        lines.push("");
        pushInitialMessages(lines, run.initialMessages, ctx.opts);
        lines.push("");
    }

    const steps = ctx.stepsByRun.get(run.id) ?? [];
    const { attachmentsByStep, orphans } = correlateChildren(run, ctx);

    lines.push("### Step Protocol");
    lines.push("");
    if (steps.length === 0) {
        lines.push("_(no steps recorded)_");
        lines.push("");
    }
    for (const step of steps) {
        renderStep(lines, step, ctx, attachmentsByStep.get(step.id) ?? []);
    }

    // Any child we couldn't tie to a tool call is rendered after the last
    // step so the report stays complete.
    for (const child of orphans) {
        lines.push("");
        lines.push("> _(could not correlate to a tool call)_");
        for (const cl of prefixBlockquote(
            renderAgentrunBlock(child, ctx, { nested: true, label: "Agentrun" }),
        )) {
            lines.push(cl);
        }
    }

    // Final result. A top-level block always shows it (with a pending
    // placeholder when the run hasn't settled); a nested block only when
    // the child has actually settled.
    if (!role.nested) {
        lines.push("");
        lines.push("## Final Result");
        lines.push("");
        pushResult(lines, run, ctx.opts);
    } else if (run.state === "done" || run.state === "failed") {
        lines.push("");
        lines.push("**Result:**");
        lines.push("");
        pushResult(lines, run, ctx.opts);
    }

    return lines;
}

/**
 * Render one step: the numbered header (with token suffix at `-v`), the
 * thinking line, the `tool_call:` / `stop` line, optional per-call I/O
 * blocks (`-vv`), then any spawned-subagent or scheduled-handler
 * attachments inline.
 */
function renderStep(
    lines: string[],
    step: StepResultRow,
    ctx: RenderCtx,
    attachments: readonly StepAttachment[],
): void {
    const num = String(step.stepNumber + 1).padStart(2, "0");

    // The header and the indented Thinking / tool_call lines form one
    // list item; emit them as a group so the line-break style stays in
    // one place (see pushStepHead).
    const head: string[] = [];
    const suffix = ctx.opts.verbosity >= 1 ? tokenSuffix(step) : null;
    // Bold pseudo-number rather than a real markdown ordered list: a `>`
    // blockquote (nested subagent) between two list items splits the list,
    // and `marked-terminal` then renumbers each segment from 1. A bold
    // line carries no list semantics, so the explicit step numbers survive
    // verbatim at every nesting depth.
    head.push(suffix ? `**${num}. Step:** __(${suffix})__` : `**${num}. Step**`);
    if (step.reasoningText && step.reasoningText.trim().length > 0) {
        pushThinking(head, trimProse(step.reasoningText, ctx.opts));
    }
    const calls = asArray(step.toolCalls);
    if (calls.length > 0) {
        const names = calls.map((c) => (c as { toolName?: string }).toolName ?? "<unknown>");
        head.push(`    tool_call: ${names.join(", ")}`);
    } else {
        head.push("    stop");
    }
    pushStepHead(lines, head);

    if (ctx.opts.verbosity >= 2 && calls.length > 0) {
        const results = asArray(step.toolResults);
        for (const call of calls) {
            lines.push("");
            lines.push("```javascript");
            for (const ioLine of renderToolIO(call, results, ctx.opts).split("\n")) {
                lines.push(ioLine);
            }
            lines.push("```");
        }
    }

    for (const att of attachments) {
        lines.push("");
        if (att.kind === "scheduled") {
            const ref = att.topic ? `${att.topic}/${att.handler}` : att.handler;
            lines.push(`> ### Scheduled handler \`${ref}\` — wakeup at ${att.when}`);
        } else {
            for (const cl of prefixBlockquote(
                renderAgentrunBlock(att.child, ctx, { nested: true, label: "Agentrun" }),
            )) {
                lines.push(cl);
            }
        }
    }
    // A trailing blank line terminates the last attachment's blockquote so
    // the next numbered step isn't swallowed as a lazy continuation of it.
    if (attachments.length > 0) {
        lines.push("");
    }
}

/**
 * Correlate each step's tool calls to the child agentruns they spawned.
 * No link is stored, so: `call_handler` consumes the next unconsumed
 * `'called'` child in creation order; `schedule_handler` (immediate)
 * carries `{ agentrunId }` in its result and is matched by id exactly,
 * falling back to the next `'queued'` child if the id is unavailable;
 * `schedule_handler` (deferred) carries `{ key, when }`, spawns no child,
 * and yields an inline placeholder. Anything left over is returned as an
 * orphan so the caller still renders it.
 */
function correlateChildren(
    run: AgentRunRow,
    ctx: RenderCtx,
): { attachmentsByStep: Map<string, StepAttachment[]>; orphans: AgentRunRow[] } {
    const children = (ctx.childrenByParent.get(run.id) ?? []).slice();
    const consumed = new Set<string>();
    const attachmentsByStep = new Map<string, StepAttachment[]>();

    const attach = (stepId: string, att: StepAttachment): void => {
        const arr = attachmentsByStep.get(stepId) ?? [];
        arr.push(att);
        attachmentsByStep.set(stepId, arr);
    };
    const nextUnconsumed = (calltype: "called" | "queued"): AgentRunRow | undefined =>
        children.find((c) => !consumed.has(c.id) && c.calltype === calltype);

    for (const step of ctx.stepsByRun.get(run.id) ?? []) {
        const results = asArray(step.toolResults);
        for (const call of asArray(step.toolCalls)) {
            const name = (call as { toolName?: string }).toolName;
            if (name === "call_handler") {
                const child = nextUnconsumed("called");
                if (child) {
                    consumed.add(child.id);
                    attach(step.id, { kind: "child", child });
                }
                continue;
            }
            if (name !== "schedule_handler") {
                continue;
            }
            const callId = (call as { toolCallId?: string }).toolCallId;
            const out = toolOutput(results.find((r) => matchesCallId(r, callId)));
            const agentrunId =
                out &&
                typeof out === "object" &&
                typeof (out as { agentrunId?: unknown }).agentrunId === "string"
                    ? (out as { agentrunId: string }).agentrunId
                    : null;
            if (agentrunId) {
                const child = children.find((c) => c.id === agentrunId && !consumed.has(c.id));
                if (child) {
                    consumed.add(child.id);
                    attach(step.id, { kind: "child", child });
                }
                continue;
            }
            const when =
                out &&
                typeof out === "object" &&
                typeof (out as { when?: unknown }).when === "string"
                    ? (out as { when: string }).when
                    : null;
            if (when !== null) {
                const input =
                    (call as { input?: { topic?: string; handler?: string } }).input ?? {};
                attach(step.id, {
                    kind: "scheduled",
                    topic: input.topic,
                    handler: input.handler ?? "?",
                    when,
                });
                continue;
            }
            // Offloaded / unexpected result shape: fall back to creation order.
            const child = nextUnconsumed("queued");
            if (child) {
                consumed.add(child.id);
                attach(step.id, { kind: "child", child });
            }
        }
    }

    const orphans = children.filter((c) => !consumed.has(c.id));
    return { attachmentsByStep, orphans };
}

/**
 * Build the render context: index every run's children by parent id
 * (id-sorted, the creation order the correlation pass relies on).
 */
function buildCtx(
    runs: readonly AgentRunRow[],
    stepsByRun: Map<string, readonly StepResultRow[]>,
    opts: RenderOptions,
): RenderCtx {
    const childrenByParent = new Map<string, AgentRunRow[]>();
    for (const run of runs) {
        if (run.parentAgentrunId === null) {
            continue;
        }
        const arr = childrenByParent.get(run.parentAgentrunId) ?? [];
        arr.push(run);
        childrenByParent.set(run.parentAgentrunId, arr);
    }
    for (const arr of childrenByParent.values()) {
        arr.sort((a, b) => Number(a.id) - Number(b.id));
    }
    return { childrenByParent, stepsByRun, opts };
}

/**
 * Emit the step's head group (the bold step line + indented Thinking /
 * tool_call lines). The indented lines are paragraph continuations of the
 * step line; a trailing hard break (two spaces) on every line but the
 * last forces the renderer to keep them on separate display lines instead
 * of collapsing the soft breaks into one paragraph.
 */
function pushStepHead(lines: string[], head: readonly string[]): void {
    for (let i = 0; i < head.length; i++) {
        lines.push(i < head.length - 1 ? `${head[i]}  ` : head[i]);
    }
}

/**
 * Push the `Thinking:` line(s) for a step. Single-line reasoning becomes
 * `    Thinking: __<text>__`; multi-line reasoning keeps its breaks with
 * each continuation indented 4 spaces, the whole span wrapped in `__`.
 * Internal blank lines are collapsed so they don't terminate the bold
 * span / list item.
 */
function pushThinking(lines: string[], text: string): void {
    const collapsed = text.replace(/\n\s*\n+/g, "\n").trim();
    const parts = collapsed.split("\n");
    if (parts.length === 1) {
        lines.push(`    Thinking: __${parts[0]}__`);
        return;
    }
    lines.push(`    Thinking: __${parts[0]}`);
    for (let i = 1; i < parts.length - 1; i++) {
        lines.push(`    ${parts[i]}`);
    }
    lines.push(`    ${parts[parts.length - 1]}__`);
}

/** Token counts, summed across one step or across an entire event. */
interface TokenTotals {
    total: number;
    cacheRead: number;
    noCache: number;
    textOut: number;
    reasoningOut: number;
}

/** Token usage of a single step (with `totalTokens` falling back to in+out). */
function stepTotals(step: StepResultRow): TokenTotals {
    return {
        total: step.totalTokens ?? (step.inputTokens ?? 0) + (step.outputTokens ?? 0),
        cacheRead: step.inputTokensCacheRead ?? 0,
        noCache: step.inputTokensNoCache ?? 0,
        textOut: step.outputTokensText ?? 0,
        reasoningOut: step.outputTokensReasoning ?? 0,
    };
}

/** Sum token usage across every step of every agentrun in the event. */
function sumEventTokens(stepsByRun: Map<string, readonly StepResultRow[]>): TokenTotals {
    const sum: TokenTotals = { total: 0, cacheRead: 0, noCache: 0, textOut: 0, reasoningOut: 0 };
    for (const steps of stepsByRun.values()) {
        for (const step of steps) {
            const t = stepTotals(step);
            sum.total += t.total;
            sum.cacheRead += t.cacheRead;
            sum.noCache += t.noCache;
            sum.textOut += t.textOut;
            sum.reasoningOut += t.reasoningOut;
        }
    }
    return sum;
}

/** The non-zero breakdown segments (`3800 cached in`, `2000 in`, …) of a total. */
function tokenBreakdown(t: TokenTotals): string[] {
    const parts: string[] = [];
    if (t.cacheRead) {
        parts.push(`${t.cacheRead} cached in`);
    }
    if (t.noCache) {
        parts.push(`${t.noCache} in`);
    }
    if (t.textOut) {
        parts.push(`${t.textOut} text out`);
    }
    if (t.reasoningOut) {
        parts.push(`${t.reasoningOut} reasoning out`);
    }
    return parts;
}

/**
 * Build the `-v` per-step token suffix, e.g.
 * `12709 tokens total: 3800 cached in + 2000 in + 33 text out`.
 * Zero / null breakdown elements are omitted; returns `null` when there
 * is nothing to report.
 */
function tokenSuffix(step: StepResultRow): string | null {
    const t = stepTotals(step);
    const parts = tokenBreakdown(t);
    if (!t.total && parts.length === 0) {
        return null;
    }
    return parts.length > 0
        ? `${t.total} tokens total: ${parts.join(" + ")}`
        : `${t.total} tokens total`;
}

/**
 * Render one tool call's `-vv` I/O line: `name(<input json>) => <output>`.
 * String outputs that aren't JSON-shaped are rendered as a backtick
 * template literal preserving newlines; everything else as JSON. A
 * tool-error surfaces as `Error: <message>`.
 */
function renderToolIO(call: unknown, results: readonly unknown[], opts: RenderOptions): string {
    const name = (call as { toolName?: string }).toolName ?? "<unknown>";
    const input = (call as { input?: unknown }).input;
    const callId = (call as { toolCallId?: string }).toolCallId;
    const match = results.find((r) => matchesCallId(r, callId));
    const inputJson = jsonBlock(input, opts);

    if (match && (match as { type?: string }).type === "tool-error") {
        return `${name}(${inputJson}) => Error: ${asErrorText((match as { error?: unknown }).error)}`;
    }
    const output = match ? (match as { output?: unknown }).output : undefined;
    if (typeof output === "string" && !output.trimStart().startsWith("{")) {
        const body = opts.truncate ? trimProse(output, opts) : output;
        return `${name}(${inputJson}) => \`\n${body}\n\``;
    }
    return `${name}(${inputJson}) => ${jsonBlock(output, opts)}`;
}

/**
 * Push the initial-message-history list (`-vv`). Renders the
 * not-recorded note when the column is null, else one bullet per message
 * with its role and flattened, single-lined content.
 */
function pushInitialMessages(lines: string[], initialMessages: unknown, opts: RenderOptions): void {
    if (initialMessages === null || initialMessages === undefined) {
        lines.push(
            "_Not recorded. Set inference.captureInitialMessageHistory to true in the config to enable recording._",
        );
        return;
    }
    const arr = Array.isArray(initialMessages) ? initialMessages : [];
    if (arr.length === 0) {
        lines.push("_(empty)_");
        return;
    }
    for (const m of arr) {
        const role =
            m && typeof m === "object" && "role" in m ? String((m as { role: unknown }).role) : "?";
        const content =
            m && typeof m === "object" && "content" in m
                ? flattenContent((m as { content: unknown }).content)
                : "";
        lines.push(`* \`[${role}]\`: ${trimProse(oneLine(content), opts)}`);
    }
}

/**
 * Push the result blockquote for a run: the pending placeholder when the
 * run hasn't settled, else the error text (failed) or the final result
 * text (done), with a fallback note when neither is present.
 */
function pushResult(lines: string[], run: AgentRunRow, opts: RenderOptions): void {
    if (run.state !== "done" && run.state !== "failed") {
        pushBlockquote(lines, "__still pending__");
        return;
    }
    if (run.error) {
        pushBlockquote(lines, trimProse(run.error, opts));
        return;
    }
    if (run.resultText && run.resultText.length > 0) {
        pushBlockquote(lines, trimProse(run.resultText, opts));
        return;
    }
    pushBlockquote(lines, "_(no result text)_");
}

/** Flatten a model-message `content` (string or part array) to a string. */
function flattenContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) =>
                part && typeof part === "object" && "text" in part
                    ? String((part as { text: unknown }).text)
                    : typeof part === "string"
                      ? part
                      : safeStringify(part),
            )
            .join("");
    }
    return content === null || content === undefined ? "" : safeStringify(content);
}

/** True when a persisted tool result matches the given tool-call id. */
function matchesCallId(result: unknown, callId: string | undefined): boolean {
    return (
        callId !== undefined &&
        typeof result === "object" &&
        result !== null &&
        (result as { toolCallId?: string }).toolCallId === callId
    );
}

/** Extract a persisted tool result's `output` value (the tool's return). */
function toolOutput(result: unknown): unknown {
    if (result === null || typeof result !== "object") {
        return undefined;
    }
    return (result as { output?: unknown }).output;
}

/**
 * Pretty-print a value as JSON. When `truncate` is on, every leaf string
 * is capped at {@link TRUNCATE_STRING_CHARS}; otherwise the value is
 * serialized in full.
 */
function jsonBlock(value: unknown, opts: RenderOptions): string {
    if (opts.truncate) {
        return truncateJson(value, TRUNCATE_STRING_CHARS);
    }
    return safeStringify(value);
}

/**
 * Pretty-print a value as JSON with every leaf string truncated at `max`
 * characters. Arrays / objects / primitives keep their structure so the
 * output stays parseable.
 */
function truncateJson(value: unknown, max: number): string {
    try {
        return JSON.stringify(truncateStringsDeep(value, max), null, 2) ?? String(value);
    } catch {
        return String(value);
    }
}

/** Recursively copy a value tree, truncating every leaf string at `max`. */
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

/** Truncate a prose blob to {@link TRUNCATE_PROSE_CHARS} when `truncate` is on. */
function trimProse(text: string, opts: RenderOptions): string {
    if (!opts.truncate || text.length <= TRUNCATE_PROSE_CHARS) {
        return text;
    }
    return `${text.slice(0, TRUNCATE_PROSE_CHARS)}…`;
}

/**
 * Coerce a persisted `tool-error.error` to a renderable string.
 * `AgentRunner` flattens errors to `<code>: <message>` before
 * persisting, but older rows may carry other shapes — handle defensively.
 */
function asErrorText(value: unknown): string {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    if (value === undefined || value === null) {
        return "tool error";
    }
    return safeStringify(value);
}

/** JSON-serialize defensively, falling back to `String(value)` on failure. */
function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
        return String(value);
    }
}

/** Collapse all whitespace runs to single spaces and trim. */
function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** Bound the idempotency-key cell: a dash when absent, else the first N chars. */
function idempotencyKeyCell(key: string | null): string {
    if (!key) {
        return "—";
    }
    return oneLine(key).slice(0, IDEMPOTENCY_KEY_PREVIEW_CHARS);
}

/** Append a multi-line value as a markdown blockquote — `> ` per line. */
function pushBlockquote(lines: string[], text: string): void {
    for (const line of text.split("\n")) {
        lines.push(line === "" ? ">" : `> ${line}`);
    }
}

/**
 * Prefix every line of a rendered block with a blockquote marker. Blank
 * lines become a bare `>` (not `"> "`) so the blockquote isn't
 * terminated mid-block — this is what lets a nested agentrun keep its
 * headings, list, and code blocks intact one level deeper.
 */
function prefixBlockquote(lines: readonly string[]): string[] {
    return lines.map((line) => (line === "" ? ">" : `> ${line}`));
}

/** Format a timestamp as `YYYY-MM-DD HH:MM:SS` in local time. */
function formatTs(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Capitalize the first letter (e.g. `done` → `Done`). */
function capitalize(s: string): string {
    return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Coerce an unknown to an array, or `[]` when it isn't one. */
function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

/** True when a value is a non-empty object / non-null primitive worth rendering. */
function hasContent(value: unknown): boolean {
    if (value === null || value === undefined) {
        return false;
    }
    if (typeof value === "object" && Object.keys(value as object).length === 0) {
        return false;
    }
    return true;
}

/** Trim trailing blank lines, join with newlines, end with exactly one newline. */
function joinDocument(lines: string[]): string {
    const copy = [...lines];
    while (copy.length > 0 && copy[copy.length - 1] === "") {
        copy.pop();
    }
    return `${copy.join("\n")}\n`;
}
