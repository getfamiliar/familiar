import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatHandler, ChatMessage, HostContext } from "@getfamiliar/shared";
import type { ChatPromptConfig, ChatPromptFn, ChatPromptResult } from "./ChatPrompt.js";
import { runRepl } from "./Repl.js";

/**
 * Build a `ChatMessage` with sensible defaults for the fields the REPL
 * actually reads (`id`, `textContent`).
 */
function makeMsg(id: string, textContent: string): ChatMessage {
    return {
        id,
        eventId: "1",
        role: "assistant",
        textContent,
        createdAt: new Date(),
        deliveredAt: null,
    };
}

/**
 * Minimal fake {@link HostContext} for driving `runRepl`. Captures the
 * single session chat handler so a test can push proactive/backlog
 * messages, records `appendAssistantMessage` calls, and lets a test
 * decide what `events.emit().settled` resolves to (and whether a reply
 * is delivered mid-turn).
 */
function makeCtx(options: {
    readonly onSubscribe?: (handler: ChatHandler) => Promise<void> | void;
    readonly onEmit?: (handler: ChatHandler) => Promise<void> | void;
    readonly settledText?: string;
}): {
    readonly ctx: HostContext;
    readonly appended: Array<{ eventId: string; text: string }>;
    handler(): ChatHandler;
} {
    let captured: ChatHandler | undefined;
    const appended: Array<{ eventId: string; text: string }> = [];

    const ctx = {
        dataDir: "/nonexistent-workspace-for-test",
        daemonDownSignal: new AbortController().signal,
        chat: {
            async subscribe(_filter: unknown, handler: ChatHandler) {
                captured = handler;
                await options.onSubscribe?.(handler);
                return async () => {};
            },
            async appendAssistantMessage(eventId: string, text: string) {
                appended.push({ eventId, text });
            },
        },
        events: {
            async emit() {
                if (captured) {
                    await options.onEmit?.(captured);
                }
                return {
                    id: "h1",
                    settled: Promise.resolve(options.settledText ?? "result text"),
                };
            },
        },
    } as unknown as HostContext;

    return {
        ctx,
        appended,
        handler() {
            if (!captured) {
                throw new Error("subscribe was not called");
            }
            return captured;
        },
    };
}

/**
 * Capture everything written to stdout for the duration of `fn`,
 * appending each chunk to `chunks` so a caller can also inspect output
 * mid-run. Writes are *forwarded* to the real stdout — `runRepl`
 * awaits internally, and swallowing writes during that window would
 * also swallow node:test's reporter output (miscounting tests).
 */
async function captureStdout(fn: () => Promise<void>, chunks: string[] = []): Promise<string> {
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
        return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
        await fn();
    } finally {
        process.stdout.write = original;
    }
    return chunks.join("");
}

test("startup backlog renders before the first prompt", async () => {
    // subscribe replays two undelivered messages synchronously during
    // registration, mirroring ChatMessageBus's replay pass.
    const { ctx } = makeCtx({
        onSubscribe: async (handler) => {
            await handler(makeMsg("1", "queued one"));
            await handler(makeMsg("2", "queued two"));
        },
    });

    const chunks: string[] = [];
    let stdoutAtFirstPrompt = "";
    const prompt: ChatPromptFn = async () => {
        // Snapshot what's been printed by the time the prompt is shown.
        stdoutAtFirstPrompt = chunks.join("");
        return { value: "/exit", reason: "submit" };
    };

    const out = await captureStdout(async () => {
        await runRepl(ctx, prompt);
    }, chunks);

    assert.ok(
        out.includes("queued one") && out.includes("queued two"),
        "both backlog msgs printed",
    );
    assert.ok(
        stdoutAtFirstPrompt.includes("queued one") && stdoutAtFirstPrompt.includes("queued two"),
        "backlog was rendered before the first prompt appeared",
    );
});

test("a proactive message while idle interrupts the prompt and preserves the typed buffer", async () => {
    const { ctx, handler } = makeCtx({});

    const initialValues: Array<string | undefined> = [];
    let promptCall = 0;
    const prompt: ChatPromptFn = async (config: ChatPromptConfig) => {
        promptCall += 1;
        initialValues.push(config.initialValue);
        if (promptCall === 1) {
            return new Promise<ChatPromptResult>((resolve) => {
                config.interruptSignal?.addEventListener(
                    "abort",
                    () => resolve({ value: "half typed", reason: "interrupted" }),
                    { once: true },
                );
                // Now that we're idle at the prompt, a proactive message
                // arrives — the handler renders it and aborts the prompt.
                void handler()(makeMsg("9", "proactive ping"));
            });
        }
        return { value: "/exit", reason: "submit" };
    };

    const out = await captureStdout(async () => {
        await runRepl(ctx, prompt);
    });

    assert.equal(promptCall, 2, "prompt redrawn once after the interrupt");
    assert.equal(
        initialValues[1],
        "half typed",
        "the half-typed buffer is carried into the redraw",
    );
    const occurrences = out.split("proactive ping").length - 1;
    assert.equal(occurrences, 1, "the proactive message is rendered exactly once");
});

test("a reply delivered during a turn suppresses the result_text fallback", async () => {
    // emit delivers an assistant message before settling, so the
    // watermark advances and runTurn must NOT append result_text.
    const { ctx, appended } = makeCtx({
        settledText: "result text",
        onEmit: async (handler) => {
            await handler(makeMsg("5", "the actual reply"));
        },
    });

    let promptCall = 0;
    const prompt: ChatPromptFn = async () => {
        promptCall += 1;
        return promptCall === 1
            ? { value: "hello", reason: "submit" }
            : { value: "/exit", reason: "submit" };
    };

    await captureStdout(async () => {
        await runRepl(ctx, prompt);
    });

    assert.equal(appended.length, 0, "no fallback append when a reply arrived during the turn");
});

test("no reply during a turn falls back to persisting result_text", async () => {
    const { ctx, appended } = makeCtx({ settledText: "result text" });

    let promptCall = 0;
    const prompt: ChatPromptFn = async () => {
        promptCall += 1;
        return promptCall === 1
            ? { value: "hello", reason: "submit" }
            : { value: "/exit", reason: "submit" };
    };

    await captureStdout(async () => {
        await runRepl(ctx, prompt);
    });

    assert.deepEqual(
        appended,
        [{ eventId: "h1", text: "result text" }],
        "result_text persisted when nothing was delivered during the turn",
    );
});
