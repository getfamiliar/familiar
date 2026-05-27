import path from "node:path";
import {
    DaemonStoppedError,
    EVENT_PRIORITY,
    HandlerCatalog,
    type HostContext,
    type NewEvent,
} from "@getfamiliar/shared";
import chalk from "chalk";
import { type ChatPromptFn, chatPrompt } from "./ChatPrompt.js";
import { CLI_CHAT_BUILTINS, type ParsedInput, parseInput } from "./InputParser.js";
import { RunRenderer } from "./RunRenderer.js";

const CLI_CHANNEL = "cli";
const ANSI_CLEAR_SCREEN = "\x1b[2J\x1b[H";
const DAEMON_GOODBYE = "The daemon has stopped. Goodbye.";

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
export async function runRepl(ctx: HostContext, prompt: ChatPromptFn = chatPrompt): Promise<void> {
    const isTty = process.stdout.isTTY === true;
    const writablePaths = ctx.config.getStringList("core.writablePaths", ["wiki/**"]);
    const catalog = new HandlerCatalog(path.join(ctx.dataDir, "workspace"), writablePaths);

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

    // Fold the host's daemon-down signal into the session abort so the
    // REPL drops out of its prompt and out of any in-flight `handle.settled`
    // wait the moment the daemon goes away. The outer loop then notices
    // `daemonDownSignal.aborted` (vs. a plain user Ctrl-C) and prints the
    // farewell line below.
    const onDaemonDown = () => sessionAbort.abort();
    if (ctx.daemonDownSignal.aborted) {
        sessionAbort.abort();
    } else {
        ctx.daemonDownSignal.addEventListener("abort", onDaemonDown, { once: true });
    }

    // In-memory only, scoped to this REPL session. Up/Down inside the
    // prompt walks through these in submission order, oldest first.
    const history: string[] = [];

    // One renderer for the whole session: turn replies and proactive
    // messages share its spinner state, so they never fight two
    // renderers for `log-update`. The renderer's own `spinner` field
    // is the "is a turn active" discriminator that routes a chat
    // message either into the active spinner's suffix or straight to
    // stdout (see RunRenderer.chatAnswer).
    const renderer = new RunRenderer(isTty);
    // True only while `runTurn` is blocking. Tells the chat handler
    // whether a proactive message should interrupt the idle prompt
    // (it shouldn't while a turn owns the screen).
    let turnActive = false;
    // Monotonic count of assistant chatmessages delivered this session.
    // `runTurn` snapshots it to derive "did a reply arrive during my
    // turn" without a per-turn subscription.
    let chatMsgCount = 0;
    // Per-iteration handle the chat handler aborts to kick the idle
    // prompt into a graceful "interrupted" resolve.
    let promptAbort: AbortController | undefined;
    // Buffer carried over from a prompt that was interrupted by a
    // proactive message, re-seeded into the next prompt so no typed
    // keystrokes are lost.
    let pendingBuffer = "";
    // Proactive / backlog messages that arrived while no prompt was
    // active. They are NOT rendered from the subscription handler —
    // writing to stdout under a live inquirer prompt corrupts its line
    // accounting and leaves ghost prompts. Instead they queue here and
    // the loop flushes them at the top of an iteration, when the
    // terminal is clean (no prompt mounted yet).
    const pendingMessages: string[] = [];

    // Single session-long subscription to the cli assistant channel.
    // Opened before the first prompt so the bus's replay pass enqueues
    // any startup backlog immediately — letting the model "speak
    // first". Live proactive messages enqueue the same way while idle.
    const unsubscribe = await ctx.chat.subscribe(
        { channelId: CLI_CHANNEL, role: "assistant" },
        async (m) => {
            chatMsgCount += 1;
            if (turnActive) {
                // A turn owns the screen: its spinner absorbs the reply.
                renderer.chatAnswer(m.textContent);
            } else {
                // Idle: queue the text and bounce the prompt so the loop
                // renders it cleanly above a fresh, redrawn prompt.
                pendingMessages.push(m.textContent);
                promptAbort?.abort();
            }
            return true;
        },
    );

    try {
        while (!sessionAbort.signal.aborted) {
            // Create the interrupt handle before flushing so a message
            // arriving mid-flush aborts *this* iteration's prompt; its
            // on-mount aborted-check then bounces us straight back here.
            promptAbort = new AbortController();

            // Render anything queued while no prompt was active. Safe to
            // write to stdout now — no inquirer prompt is mounted yet.
            if (pendingMessages.length > 0) {
                for (const text of pendingMessages.splice(0)) {
                    renderer.chatAnswer(text);
                }
            }

            const handlerPaths = (await catalog.list()).map((h) => h.slashPath);
            let result: Awaited<ReturnType<ChatPromptFn>>;
            try {
                result = await prompt(
                    {
                        builtins: CLI_CHAT_BUILTINS,
                        handlerPaths,
                        history,
                        interruptSignal: promptAbort.signal,
                        initialValue: pendingBuffer,
                    },
                    { signal: sessionAbort.signal },
                );
            } catch (err) {
                if (sessionAbort.signal.aborted || isAbortError(err)) {
                    break;
                }
                throw err;
            }

            pendingBuffer = "";
            if (result.reason === "interrupted") {
                // A proactive message arrived. Carry the partial input
                // forward; the next iteration flushes the queued message
                // and redraws the prompt seeded with what was typed.
                pendingBuffer = result.value;
                continue;
            }

            const raw = result.value;
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
                // Skip only empty *plain* prompts (bare Enter). A
                // handler-only line like `/calendar/today` carries a
                // topic with an empty prompt and is a valid invocation
                // — buildNewEvent supplies a placeholder prompt for it.
                // Mirrors the runOneShot guard below.
                if (parsed.prompt.length === 0 && parsed.topic === undefined) {
                    continue;
                }
                turnActive = true;
                const countAtStart = chatMsgCount;
                try {
                    await runTurn(
                        ctx,
                        catalog,
                        parsed,
                        sessionAbort.signal,
                        renderer,
                        () => chatMsgCount,
                        countAtStart,
                    );
                } finally {
                    turnActive = false;
                }
            }
        }
    } finally {
        await unsubscribe().catch(() => {
            // Daemon-down is the dominant teardown failure here; swallow
            // so we don't paper over the goodbye line with a stack trace.
        });
        renderer.stop();
        process.off("SIGINT", onSigint);
        ctx.daemonDownSignal.removeEventListener("abort", onDaemonDown);
        if (ctx.daemonDownSignal.aborted) {
            process.stdout.write(`${chalk.gray(DAEMON_GOODBYE)}\n`);
        }
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
 * emit, drive the shared {@link RunRenderer} from the emit callbacks,
 * and tear down when the event settles or the user hits Ctrl-C.
 *
 * The chat subscription is owned by {@link runRepl} for the whole
 * session, so this turn doesn't open its own. Whether an assistant
 * reply arrived *during* the turn is derived from the session's
 * monotonic message counter: `currentChatCount() > countAtStart`. That
 * flag (`sawChatAnswer`) decides whether we persist the agentrun's
 * `result_text` as a fallback chatmessage — needed for direct-call
 * handlers (`/mail/draft …`) that don't emit a chat reply themselves.
 */
async function runTurn(
    ctx: HostContext,
    catalog: HandlerCatalog,
    parsed: Extract<ParsedInput, { kind: "handler" }>,
    sessionSignal: AbortSignal,
    renderer: RunRenderer,
    currentChatCount: () => number,
    countAtStart: number,
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

    const debug = process.env.CLI_CHAT_DEBUG === "1";
    let sawAgentRun = false;
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
        handle.settled
            .then((text) => ({ done: text }) as const)
            .catch((e) => ({ failed: e }) as const),
        abortPromise,
    ]);

    clearTimeout(watchdog);
    if (result === "aborted") {
        renderer.stop();
        return;
    }
    if ("failed" in result) {
        // Daemon-down rejected `settled` with `DaemonStoppedError`
        // (or `sessionSignal` aborted slightly later and the
        // `failed` branch carries whatever postgres complained
        // about as the daemon went away). Either way the run
        // didn't really "fail" in the handler sense — suppress
        // the red `renderer.failed(...)` and let `runRepl`'s
        // outer goodbye line cover it.
        if (ctx.daemonDownSignal.aborted || result.failed instanceof DaemonStoppedError) {
            renderer.stop();
            return;
        }
        // For ordinary agentrun failures the host already wrote a
        // `Something went wrong processing the chat message: …`
        // assistant chatmessage to this event (driven by
        // `outputChatOnFailure: true` in `buildNewEvent`). It
        // arrives through `renderer.chatAnswer` like any other
        // reply, so we only need to fall back to `renderer.failed`
        // when nothing came through — e.g. the failure-write
        // itself errored, or the NOTIFY hasn't been delivered yet.
        if (currentChatCount() === countAtStart) {
            const message =
                result.failed instanceof Error ? result.failed.message : String(result.failed);
            renderer.failed(message);
        } else {
            renderer.stop();
        }
        return;
    }
    // Success path: persist the agentrun's `result_text` as an
    // assistant chatmessage when no handler-emitted reply showed
    // up. Direct calls to non-chat handlers (e.g. `/mail/draft`)
    // typically don't have `outputChat: true`, so without this
    // they leave the chat record with a user line and no reply.
    const resultText = result.done.trim();
    if (currentChatCount() === countAtStart && resultText.length > 0) {
        await ctx.chat.appendAssistantMessage(handle.id, resultText);
    }
    renderer.done();
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
            // Surface model / handler failures through the chat
            // subscription so the operator sees a visible reply
            // instead of a silent transcript on error.
            outputChatOnFailure: true,
        };
    }
    return {
        topic: parsed.topic,
        startHandler: parsed.startHandler,
        // Direct handler calls are not "chat messages from the user"
        // — they're operator-triggered runs. Skipping `isChat` keeps
        // the AgentRunner on the agentrun-lineage context path (no
        // chat-history feed) and lets the spawned agentrun read its
        // prompt straight from `event.prompt`. The operator's slash-
        // command line still lands in chatmessages via
        // `userChatMessage`, inserted atomically with the event by
        // EventBus.add so the input-event watcher's claim can't race
        // the FK row-lock.
        isChat: false,
        priority: EVENT_PRIORITY.CHAT,
        preferredChatChannelId: CLI_CHANNEL,
        prompt: parsed.prompt.length > 0 ? parsed.prompt : `(handler invoked from cli-chat)`,
        privileged: true,
        outputChatOnFailure: true,
        userChatMessage: parsed.rawInput,
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
    const writablePaths = ctx.config.getStringList("core.writablePaths", ["wiki/**"]);
    const catalog = new HandlerCatalog(path.join(ctx.dataDir, "workspace"), writablePaths);
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
    let sawChatAnswer = false;
    const unsubscribe = await ctx.chat.subscribe(
        { channelId: CLI_CHANNEL, role: "assistant" },
        async (m) => {
            sawChatAnswer = true;
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
            const resultText = (await handle.settled).trim();
            if (!sawChatAnswer && resultText.length > 0) {
                await ctx.chat.appendAssistantMessage(handle.id, resultText);
            }
            renderer.done();
            return 0;
        } catch (err) {
            if (err instanceof DaemonStoppedError) {
                renderer.stop();
                process.stderr.write(`${chalk.gray(DAEMON_GOODBYE)}\n`);
                return 1;
            }
            if (!sawChatAnswer) {
                const message = err instanceof Error ? err.message : String(err);
                renderer.failed(message);
            } else {
                renderer.stop();
            }
            return 1;
        }
    } finally {
        await unsubscribe().catch(() => {});
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
            const trimmedResult = resultText.trim();
            // Persist the agentrun's result as an assistant chatmessage
            // when nothing else did (direct calls to non-chat handlers).
            // Mirrors the live-mode behaviour so history stays consistent
            // regardless of which entrypoint the operator used.
            if (lastChatText === undefined && trimmedResult.length > 0) {
                await ctx.chat.appendAssistantMessage(handle.id, trimmedResult);
            }
            const output = lastChatText ?? resultText;
            if (output && output.length > 0) {
                process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
            }
            return 0;
        } catch (err) {
            if (err instanceof DaemonStoppedError) {
                process.stderr.write(`${DAEMON_GOODBYE}\n`);
                return 1;
            }
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`event failed: ${message}\n`);
            return 1;
        }
    } finally {
        await unsubscribe().catch(() => {});
    }
}
