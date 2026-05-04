import { createInterface, type Interface } from "node:readline";
import type { HostContext, StepResultRow } from "effective-assistant-shared";

const CLI_CHANNEL = "cli";
const PROMPT = "> ";
const DRAIN_TIMEOUT_MS = 30_000;
const ANSI_GREY = "\x1b[90m";
const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";
const ANSI_CLEAR_LINE = "\r\x1b[2K";
const ANSI_CURSOR_UP = "\x1b[1A";

/**
 * Run the cli-chat REPL until the user exits.
 *
 * Layout invariant:
 *   ... permanent output ...
 *   [optional grey thinking line]
 *   > <input buffer>
 *
 * Concurrency: each user line kicks off `ctx.events.emit(...)` without
 * awaiting; multiple in-flight emits coexist (HostContextImpl filters
 * its `onStep` callback by event id). The `ctx.chat.subscribe` opened
 * here lasts the whole session, so assistant replies stream in as they
 * arrive — including the replay of any messages undelivered from
 * earlier sessions.
 *
 * Exit triggers (all converge on the same shutdown path):
 *   - `/exit` typed at the prompt
 *   - Ctrl-D / EOF (readline `close`)
 *   - Ctrl-C / SIGINT (readline `SIGINT` → we trigger close)
 *
 * Shutdown drains in-flight emits with a 30 s timeout. Agentruns the
 * server is still running keep running; the CLI just stops waiting
 * for them.
 */
export async function runRepl(ctx: HostContext): Promise<void> {
    const isTty = process.stdout.isTTY === true;
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: PROMPT,
        terminal: isTty,
    });

    // Register rl handlers synchronously, BEFORE any await: piped stdin
    // (`echo … | cli-chat`) starts flowing as soon as createInterface
    // attaches its internal listeners; if we awaited subscribe first
    // we would miss the line/close events that have already fired.
    const renderer = new LineRenderer(rl, isTty);
    const inFlight = new Set<Promise<unknown>>();
    let rlClosed = false;

    const submit = (rawLine: string): void => {
        const line = rawLine.trim();
        if (line.length === 0) {
            return;
        }
        if (line === "/exit") {
            rl.close();
            return;
        }
        const promise = ctx.events
            .emit(
                {
                    topic: "chat:cli",
                    isChat: true,
                    preferredChatChannelId: CLI_CHANNEL,
                    payload: { text: line },
                },
                (step) => {
                    renderer.setThinking(formatStepLine(step));
                },
            )
            .then(
                (resultText) => {
                    renderer.clearThinking();
                    if (resultText && resultText.trim().length > 0) {
                        renderer.printAbove(`[result_text] ${resultText}`);
                    }
                },
                (err) => {
                    renderer.clearThinking();
                    renderer.printError(err instanceof Error ? err.message : String(err));
                },
            )
            .finally(() => {
                inFlight.delete(promise);
            });
        inFlight.add(promise);
    };

    const userExit = new Promise<void>((resolve) => {
        rl.on("line", (line) => {
            submit(line);
            if (!rlClosed) {
                rl.prompt();
            }
        });
        rl.on("SIGINT", () => {
            rl.close();
        });
        rl.on("close", () => {
            rlClosed = true;
            resolve();
        });
    });

    const unsubscribe = await ctx.chat.subscribe(
        { channelId: CLI_CHANNEL, role: "assistant" },
        async (m) => {
            renderer.printAbove(m.textContent);
            return true;
        },
    );

    if (!rlClosed) {
        rl.prompt();
    }
    await userExit;
    renderer.afterRl();

    if (inFlight.size > 0) {
        renderer.printPlain(`Draining ${inFlight.size} in-flight message(s)…`);
        const drain = Promise.allSettled([...inFlight]);
        const timeout = new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), DRAIN_TIMEOUT_MS),
        );
        const result = await Promise.race([drain, timeout]);
        if (result === "timeout" && inFlight.size > 0) {
            ctx.log(`cli-chat REPL exit: ${inFlight.size} agentrun(s) still running server-side`);
        }
    }
    await unsubscribe();
}

/**
 * Encapsulates all stdout writes for the REPL. Maintains the layout
 * invariant by tracking whether a thinking line is currently rendered
 * just above the prompt.
 *
 * Two flavors:
 * - TTY mode: ANSI escapes to clear and rewrite the prompt (and the
 *   line above it) on every state transition.
 * - Non-TTY mode: append-only plain output. `setThinking` becomes
 *   one-line-per-step; `clearThinking` is a no-op.
 */
export class LineRenderer {
    private readonly rl: Interface;
    private readonly isTty: boolean;
    /** Desired thinking content. `null` means "no thinking line should be drawn". */
    private thinkingText: string | null = null;
    /**
     * Whether a thinking line is currently ON SCREEN. Tracked separately
     * from {@link thinkingText} so a fresh `setThinking` (with no prior
     * line on screen) does not try to erase the permanent content
     * above the prompt.
     */
    private thinkingOnScreen = false;
    private rlClosed = false;

    constructor(rl: Interface, isTty: boolean) {
        this.rl = rl;
        this.isTty = isTty;
    }

    /** Mark that readline has closed; switch to plain stdout writes. */
    afterRl(): void {
        this.rlClosed = true;
    }

    /** Plain unconditional write — used during shutdown / drain. */
    printPlain(text: string): void {
        process.stdout.write(`${text}\n`);
    }

    /** Print a permanent line above the prompt (and above any thinking). */
    printAbove(text: string): void {
        if (!this.isTty || this.rlClosed) {
            this.printPlain(text);
            return;
        }
        this.clearPromptArea();
        process.stdout.write(`${text}\n`);
        this.redrawPromptArea();
    }

    /** Print an error in red above the prompt. */
    printError(text: string): void {
        if (!this.isTty || this.rlClosed) {
            this.printPlain(`[error] ${text}`);
            return;
        }
        this.printAbove(`${ANSI_RED}[error] ${text}${ANSI_RESET}`);
    }

    /** Replace the grey thinking line with `text`, or render it for the first time. */
    setThinking(text: string): void {
        if (!this.isTty || this.rlClosed) {
            // Non-TTY: emit each step as a plain line, never erased.
            process.stdout.write(`[thinking] ${text}\n`);
            return;
        }
        this.thinkingText = text;
        this.clearPromptArea();
        this.redrawPromptArea();
    }

    /** Clear the grey thinking line if one is rendered. */
    clearThinking(): void {
        if (!this.isTty || this.rlClosed) {
            return;
        }
        if (this.thinkingText === null) {
            return;
        }
        this.thinkingText = null;
        this.clearPromptArea();
        this.redrawPromptArea();
    }

    /**
     * Erase the prompt line (and the thinking line above it if one
     * was actually drawn there). After this call the cursor sits at
     * column 0 of the topmost erased line, ready for new content.
     */
    private clearPromptArea(): void {
        process.stdout.write(ANSI_CLEAR_LINE);
        if (this.thinkingOnScreen) {
            process.stdout.write(`${ANSI_CURSOR_UP}${ANSI_CLEAR_LINE}`);
            this.thinkingOnScreen = false;
        }
    }

    /**
     * Redraw the thinking line (if `thinkingText` is set) and the
     * readline prompt with the user's preserved input buffer. Updates
     * {@link thinkingOnScreen} to match what we just drew.
     */
    private redrawPromptArea(): void {
        if (this.thinkingText !== null) {
            const truncated = truncate(this.thinkingText, terminalWidth());
            process.stdout.write(`${ANSI_GREY}${truncated}${ANSI_RESET}\n`);
            this.thinkingOnScreen = true;
        }
        process.stdout.write(this.rl.getPrompt());
        // Re-render the user's buffer. We put the cursor at end of
        // input; mid-string editing during a streaming step will jump
        // to the end. Acceptable for now.
        process.stdout.write(this.rl.line);
    }
}

/**
 * Render a {@link StepResultRow} as a one-line "thinking" summary.
 * Pure function — no IO, no readline — so it's unit-coverable.
 *
 * Branches in priority order:
 *   1. Tool calls — list the tool names. `send_chat`'s text is hidden
 *      because it arrives separately via the chat subscription; double-
 *      rendering would be confusing.
 *   2. Reasoning text — chain-of-thought from extended-thinking models.
 *   3. Plain assistant text generated this step.
 *   4. Fallback to the SDK's finishReason.
 */
export function formatStepLine(step: StepResultRow): string {
    const prefix = `↻ step ${step.stepNumber + 1}`;
    const toolNames = extractToolNames(step.toolCalls);

    if (toolNames.length > 0) {
        return `${prefix} • ${toolNames.join(", ")}`;
    }
    if (step.reasoningText && step.reasoningText.trim().length > 0) {
        return `${prefix} • ${truncate(step.reasoningText, 80)}`;
    }
    if (step.resultText && step.resultText.trim().length > 0) {
        return `${prefix} • "${truncate(step.resultText, 80)}"`;
    }
    return `${prefix} • ${step.finishReason}`;
}

/**
 * Pull `toolName` strings out of a step's `toolCalls` payload. The
 * shape is opaque to us (typed `unknown` upstream); we defensively
 * accept anything array-shaped with `toolName: string` entries.
 */
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

/** Collapse whitespace and truncate with an ellipsis if needed. */
function truncate(s: string, max: number): string {
    const collapsed = s.trim().replace(/\s+/g, " ");
    if (collapsed.length <= max) {
        return collapsed;
    }
    return `${collapsed.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Current terminal width, with a safe fallback. Read on every render
 * so a SIGWINCH-driven resize takes effect immediately.
 */
function terminalWidth(): number {
    return process.stdout.columns ?? 80;
}
