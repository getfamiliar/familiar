import path from "node:path";
import { defineCommand } from "citty";
import { definePlugin, type HostContext } from "@getfamiliar/shared";
import { runRepl } from "./Repl.js";

/**
 * cli-chat plugin.
 *
 * Two CLI surfaces:
 *
 * - `./cli.sh cli-chat` (no subcommand) enters an interactive REPL.
 *   Readline-driven; a grey "thinking" line above the prompt updates
 *   as the agent steps; assistant replies print above as they arrive
 *   via `ctx.chat.subscribe`. The user can type the next message
 *   while the previous one is still being processed. `/exit`,
 *   Ctrl-C, or Ctrl-D exit the loop. See {@link runRepl} for details.
 *
 * - `./cli.sh cli-chat send "<msg>"` is a one-shot for non-TTY
 *   scripting and CI smoke tests. Emits one event and prints any
 *   assistant replies that arrive on the cli channel during the
 *   agentrun.
 *
 * Both use the same chat-persistence pipeline (`isChat=true`,
 * `prompt` carries the user's text, channel `"cli"`); the difference
 * is purely the shell of the CLI command.
 */
export default definePlugin({
    id: "cli-chat",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    host: {
        main: (ctx) => replCommand(ctx),
        commands: (ctx) => [sendCommand(ctx)],
    },
});

const CLI_CHANNEL = "cli";

/** Bare `./cli.sh cli-chat` — interactive REPL. */
function replCommand(ctx: HostContext) {
    return defineCommand({
        meta: {
            name: "cli-chat",
            description: "Interactive chat REPL.",
        },
        async run() {
            await runRepl(ctx);
        },
    });
}

/**
 * `./cli.sh cli-chat send "<message>"` — one-shot send. Emits a single
 * `chat:cli` event and prints assistant replies (via subscription) plus
 * the agentrun's terminal result_text.
 */
function sendCommand(ctx: HostContext) {
    return defineCommand({
        meta: {
            name: "send",
            description: "Send one chat:cli message and print the assistant's reply.",
        },
        args: {
            message: {
                type: "positional",
                required: true,
                description: "Message to send.",
            },
        },
        async run({ args }) {
            const unsubscribe = await ctx.chat.subscribe(
                { channelId: CLI_CHANNEL, role: "assistant" },
                async (m) => {
                    process.stdout.write(`${m.textContent}\n`);
                    return true;
                },
            );
            try {
                // The reply prints via the chat subscription above;
                // no need to also print the agentrun's result_text.
                const handle = await ctx.events.emit({
                    topic: "chat:cli",
                    isChat: true,
                    preferredChatChannelId: CLI_CHANNEL,
                    prompt: args.message,
                    // One-shot send from the operator's local terminal;
                    // same trust model as the REPL.
                    privileged: true,
                });
                try {
                    await handle.settled;
                } catch (err) {
                    // Print the formatted failure (origin: AgentrunWatcher
                    // via formatInferenceError) and exit cleanly instead
                    // of dumping a stack trace to the operator.
                    const message = err instanceof Error ? err.message : String(err);
                    process.stderr.write(`event ${handle.id} failed: ${message}\n`);
                }
            } finally {
                await unsubscribe();
            }
        },
    });
}
