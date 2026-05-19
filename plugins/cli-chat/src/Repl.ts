import path from "node:path";
import {
    EVENT_PRIORITY,
    HandlerCatalog,
    type HostContext,
    type NewEvent,
} from "@getfamiliar/shared";
import chalk from "chalk";
import { chatPrompt } from "./ChatPrompt.js";
import { CLI_CHAT_BUILTINS, type ParsedInput, parseInput } from "./InputParser.js";
import { RunRenderer } from "./RunRenderer.js";

const CLI_CHANNEL = "cli";
const ANSI_CLEAR_SCREEN = "\x1b[2J\x1b[H";

/**
 * Run the cli-chat REPL until the user exits (`/exit`, Ctrl-C, or
 * EOF). One turn at a time: show prompt → emit event → render the
 * spinner-driven run progress → render the final assistant message
 * → loop.
 *
 * Concurrent in-flight messages (the previous REPL's "type next while
 * the last is processing" behaviour) are intentionally dropped: the
 * new layout has a single spinner anchored to the active agentrun,
 * which doesn't compose with a live input buffer underneath. If we
 * need concurrency back later it should be a separate mode.
 */
export async function runRepl(ctx: HostContext): Promise<void> {
    const isTty = process.stdout.isTTY === true;
    const catalog = new HandlerCatalog(path.join(ctx.dataDir, "workspace"));

    if (isTty) {
        const owl = supportsUtf8() ? "🦉 " : "";
        process.stdout.write(
            chalk.gray(
                `${owl}Welcome to the familiar chat. Type "/exit" or press CTRL+C to end the chat.\n\n`,
            ),
        );
    }

    const sessionAbort = new AbortController();
    const onSigint = () => sessionAbort.abort();
    process.on("SIGINT", onSigint);

    // In-memory only, scoped to this REPL session. Up/Down inside the
    // prompt walks through these in submission order, oldest first.
    const history: string[] = [];

    try {
        while (!sessionAbort.signal.aborted) {
            const handlerPaths = (await catalog.list()).map((h) => h.slashPath);

            let raw: string;
            try {
                raw = await chatPrompt(
                    {
                        builtins: CLI_CHAT_BUILTINS,
                        handlerPaths,
                        history,
                    },
                    { signal: sessionAbort.signal },
                );
            } catch (err) {
                if (sessionAbort.signal.aborted || isAbortError(err)) {
                    break;
                }
                throw err;
            }

            const trimmedRaw = raw.trim();
            if (trimmedRaw.length > 0 && history[history.length - 1] !== trimmedRaw) {
                history.push(trimmedRaw);
            }

            const parsed = parseInput(raw);
            if (parsed.kind === "builtin") {
                if (parsed.command === "/exit") {
                    break;
                }
                if (parsed.command === "/clear") {
                    if (isTty) {
                        process.stdout.write(ANSI_CLEAR_SCREEN);
                    }
                    continue;
                }
            }
            if (parsed.kind === "handler") {
                if (parsed.prompt.length === 0) {
                    continue;
                }
                await runTurn(ctx, catalog, parsed, sessionAbort.signal, isTty);
            }
        }
    } finally {
        process.off("SIGINT", onSigint);
    }
}

/**
 * Best-effort check for terminal UTF-8 support, used to decide
 * whether the welcome banner can carry the owl emoji. The Node
 * runtime doesn't expose terminal capabilities directly, so we look
 * at the standard POSIX locale variables (`LC_ALL` > `LC_CTYPE` >
 * `LANG`). If any of them mentions UTF-8 we assume the terminal can
 * render multi-byte glyphs; otherwise we play it safe and skip the
 * emoji.
 */
function supportsUtf8(): boolean {
    const locale = process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "";
    return /utf-?8/i.test(locale);
}

/**
 * Process one user turn end-to-end: validate the handler (if any),
 * open the chat subscription, emit, drive the {@link RunRenderer}
 * from the emit callbacks, and tear everything down when the event
 * settles or the user hits Ctrl-C.
 */
async function runTurn(
    ctx: HostContext,
    catalog: HandlerCatalog,
    parsed: Extract<ParsedInput, { kind: "handler" }>,
    sessionSignal: AbortSignal,
    isTty: boolean,
): Promise<void> {
    if (parsed.topic !== undefined && parsed.startHandler !== undefined) {
        const resolved = await catalog.resolve(parsed.topic, parsed.startHandler);
        if (!resolved) {
            process.stdout.write(
                chalk.red(
                    `[error] no handler found for topic="${parsed.topic}" handler="${parsed.startHandler}"\n`,
                ),
            );
            return;
        }
    }

    const renderer = new RunRenderer(isTty);
    const unsubscribe = await ctx.chat.subscribe(
        { channelId: CLI_CHANNEL, role: "assistant" },
        async (m) => {
            renderer.chatAnswer(m.textContent);
            return true;
        },
    );

    const debug = process.env.CLI_CHAT_DEBUG === "1";
    let sawAgentRun = false;
    try {
        const newEvent = buildNewEvent(parsed);
        const handle = await ctx.events.emit(newEvent, {
            onAgentRun: (row) => {
                sawAgentRun = true;
                if (debug) {
                    process.stderr.write(
                        `[cli-chat debug] onAgentRun #${row.id} state=${row.state} model=${row.model ?? "-"}\n`,
                    );
                }
                renderer.agentRun(row);
            },
            onStep: (step) => {
                if (debug) {
                    process.stderr.write(
                        `[cli-chat debug] onStep #${step.id} agentrun=${step.agentRunId} finish=${step.finishReason}\n`,
                    );
                }
                renderer.step(step);
            },
        });
        renderer.eventQueued(handle.id);
        // Surface a hint when the container appears unresponsive: if
        // no agentrun NOTIFY arrived after a few seconds, the spinner
        // is stuck on "message queued as event #X" and the operator
        // has no obvious clue why. Most common cause is the daemon
        // not running or the agent container not picking up events.
        const watchdog = setTimeout(() => {
            if (!sawAgentRun) {
                process.stderr.write(
                    chalk.yellow(
                        "[cli-chat] no agentrun observed yet — is `./cli.sh start` running and the agent container picking up events?\n",
                    ),
                );
            }
        }, 5_000);
        watchdog.unref();

        // Wire Ctrl-C: if the user aborts mid-run, stop the spinner
        // and bail. The server-side agentrun keeps going — we just
        // stop watching.
        const abortPromise = new Promise<"aborted">((resolve) => {
            const onAbort = () => {
                sessionSignal.removeEventListener("abort", onAbort);
                resolve("aborted");
            };
            if (sessionSignal.aborted) {
                resolve("aborted");
            } else {
                sessionSignal.addEventListener("abort", onAbort);
            }
        });
        const result = await Promise.race([
            handle.settled.then(() => "done" as const).catch((e) => ({ failed: e })),
            abortPromise,
        ]);

        clearTimeout(watchdog);
        if (result === "aborted") {
            renderer.stop();
            return;
        }
        if (typeof result === "object" && "failed" in result) {
            const message =
                result.failed instanceof Error ? result.failed.message : String(result.failed);
            renderer.failed(message);
            return;
        }
        renderer.done();
    } finally {
        await unsubscribe();
    }
}

/**
 * Build the {@link NewEvent} for an outgoing turn. Plain prompts
 * default to `topic: chat:cli` and let the input-event watcher pick
 * `index.md`; direct handler calls carry the parsed topic +
 * startHandler verbatim. All cli-chat events run as `privileged`
 * because the operator at the local terminal is fully trusted.
 */
function buildNewEvent(parsed: Extract<ParsedInput, { kind: "handler" }>): NewEvent {
    if (parsed.topic === undefined || parsed.startHandler === undefined) {
        return {
            topic: "chat:cli",
            isChat: true,
            priority: EVENT_PRIORITY.CHAT,
            preferredChatChannelId: CLI_CHANNEL,
            prompt: parsed.prompt,
            privileged: true,
        };
    }
    return {
        topic: parsed.topic,
        startHandler: parsed.startHandler,
        // Direct handler calls are not "chat messages from the user"
        // — they're operator-triggered runs. Skipping `isChat` keeps
        // the prompt off chatmessages and the spawned agentrun reads
        // the prompt straight from `event.prompt`.
        isChat: false,
        priority: EVENT_PRIORITY.CHAT,
        preferredChatChannelId: CLI_CHANNEL,
        prompt: parsed.prompt.length > 0 ? parsed.prompt : `(handler invoked from cli-chat)`,
        privileged: true,
    };
}

/**
 * Inquirer's `createPrompt` rejects in two distinct shapes depending
 * on how the prompt ended:
 *
 *   - `AbortPromptError` — the `signal` we passed in fired.
 *   - `ExitPromptError`  — the user hit Ctrl-C; inquirer's internal
 *                          SIGINT handler beats ours to the rejection
 *                          and throws "User force closed the prompt
 *                          with SIGINT".
 *
 * Both mean "user wants out of the prompt", and we always want them
 * to break the REPL loop quietly without a stack trace. We can't
 * import the error classes without pulling more of inquirer's
 * surface, so detect by `name`.
 */
function isAbortError(err: unknown): boolean {
    if (!(err instanceof Error)) {
        return false;
    }
    return err.name === "AbortPromptError" || err.name === "ExitPromptError";
}

/**
 * One-shot mode: `./cli.sh cli-chat "<message>"`. Parses, validates,
 * emits a single event, and either renders the full RunRenderer
 * output or — with `returnOnly` — just prints the final assistant
 * text once the event settles.
 */
export async function runOneShot(
    ctx: HostContext,
    message: string,
    options: { readonly returnOnly: boolean },
): Promise<number> {
    const isTty = process.stdout.isTTY === true;
    const catalog = new HandlerCatalog(path.join(ctx.dataDir, "workspace"));
    const parsed = parseInput(message);

    if (parsed.kind === "builtin") {
        process.stderr.write(`builtin commands like ${parsed.command} are REPL-only\n`);
        return 2;
    }
    if (parsed.prompt.length === 0 && parsed.topic === undefined) {
        process.stderr.write("empty message\n");
        return 2;
    }

    if (parsed.topic !== undefined && parsed.startHandler !== undefined) {
        const resolved = await catalog.resolve(parsed.topic, parsed.startHandler);
        if (!resolved) {
            process.stderr.write(
                `no handler found for topic="${parsed.topic}" handler="${parsed.startHandler}"\n`,
            );
            return 1;
        }
    }

    if (options.returnOnly) {
        return runOneShotReturnOnly(ctx, parsed);
    }

    const renderer = new RunRenderer(isTty);
    const unsubscribe = await ctx.chat.subscribe(
        { channelId: CLI_CHANNEL, role: "assistant" },
        async (m) => {
            renderer.chatAnswer(m.textContent);
            return true;
        },
    );
    try {
        const handle = await ctx.events.emit(buildNewEvent(parsed), {
            onAgentRun: (row) => renderer.agentRun(row),
            onStep: (step) => renderer.step(step),
        });
        renderer.eventQueued(handle.id);
        try {
            await handle.settled;
            renderer.done();
            return 0;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            renderer.failed(message);
            return 1;
        }
    } finally {
        await unsubscribe();
    }
}

/**
 * `--return` mode: silent spinner-free run that prints only the final
 * assistant text to stdout once the event settles. The "final" text
 * is the last assistant chat message we saw before `handle.settled`
 * resolved; if the agentrun produced no chat message we fall back to
 * the event's `result_text` (the same value `handle.settled` resolves
 * with).
 */
async function runOneShotReturnOnly(
    ctx: HostContext,
    parsed: Extract<ParsedInput, { kind: "handler" }>,
): Promise<number> {
    let lastChatText: string | undefined;
    const unsubscribe = await ctx.chat.subscribe(
        { channelId: CLI_CHANNEL, role: "assistant" },
        async (m) => {
            lastChatText = m.textContent;
            return true;
        },
    );
    try {
        const handle = await ctx.events.emit(buildNewEvent(parsed));
        try {
            const resultText = await handle.settled;
            const output = lastChatText ?? resultText;
            if (output && output.length > 0) {
                process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
            }
            return 0;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`event failed: ${message}\n`);
            return 1;
        }
    } finally {
        await unsubscribe();
    }
}
