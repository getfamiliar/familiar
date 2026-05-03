import path from "node:path";
import { defineCommand } from "citty";
import { definePlugin, type HostContext } from "effective-assistant-shared";

/**
 * cli-chat plugin.
 *
 * For now this ships a single one-shot CLI command (`send`) that emits
 * a `chat:cli` event into the bus and exits. The actual interactive
 * REPL — readline loop, subscribing to `events_state`, fetching the
 * agentrun result and printing it back — is deferred to a follow-up
 * plan that designs the necessary `HostContext` capability for
 * waiting on event terminal state.
 *
 * The agentrun still runs end-to-end via the existing watchers: the
 * input-event watcher spawns a root agentrun on the `chat:cli` event,
 * the agentrun watcher loads `chat/cli/index.md` (shipped in this
 * plugin's `workspace-template/`) and runs the agent. The reply lives
 * in `agentruns.result.text` until the REPL is built.
 */
export default definePlugin({
    id: "cli-chat",
    workspaceTemplate: path.join(__dirname, "..", "workspace-template"),
    host: {
        commands: (ctx) => [sendCommand(ctx)],
    },
});

/**
 * `cli.sh cli-chat send "<message>"` — emit a single chat:cli event,
 * await the agent's reply, and print it.
 *
 * `ctx.events.emit` blocks until the event reaches `done` (returns
 * the agentrun's `result_text`) or `failed` (throws). The thrown
 * error here surfaces as a non-zero exit and a stack trace; the
 * REPL plan will handle that more gracefully.
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
            const reply = await ctx.events.emit({
                topic: "chat:cli",
                payload: { message: args.message },
            });
            process.stdout.write(`${reply}\n`);
        },
    });
}
