import path from "node:path";
import { defineCommand } from "citty";
import { definePlugin, type HostContext } from "effective-assistant-shared";

/**
 * cli-chat plugin.
 *
 * Single one-shot CLI command (`send`) that:
 *
 * 1. Subscribes to assistant chat messages on channel `"cli"` BEFORE
 *    emitting anything so a fast assistant reply isn't missed.
 * 2. Emits a `chat:cli` event with `isChat: true` and the user's text
 *    in `payload.text`. `EventBus.add` persists the user message into
 *    `chatmessages` atomically with the event INSERT, so the agent's
 *    `ChatManager.fetchHistory` sees it as the latest turn.
 * 3. Streams every assistant message that arrives on the `cli` channel
 *    to stdout. Includes any messages that were undelivered from
 *    earlier sessions — the bus replays those on subscribe.
 * 4. Awaits the event's terminal state as the "agent done" signal.
 * 5. Unsubscribes in `finally` so the postgres LISTEN client doesn't
 *    keep the process alive.
 *
 * The interactive REPL — readline loop, keep-alive subscription
 * across multiple turns — is a separate plan.
 */
export default definePlugin({
    id: "cli-chat",
    workspaceTemplate: path.join(__dirname, "..", "workspace-template"),
    host: {
        commands: (ctx) => [sendCommand(ctx)],
    },
});

const CLI_CHANNEL = "cli";

/**
 * `cli.sh cli-chat send "<message>"` — emit one chat:cli event and
 * print every assistant reply that arrives on the cli channel until
 * the agent finishes processing it.
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
                const resultText = await ctx.events.emit({
                    topic: "chat:cli",
                    isChat: true,
                    preferredChatChannelId: CLI_CHANNEL,
                    payload: { text: args.message },
                });
                // Print the agentrun's terminal result_text in addition to
                // any send_chat replies streamed via the subscription. The
                // model isn't always deterministic about choosing the
                // tool path; surfacing both makes it visible when it
                // doesn't and aids debugging in general.
                process.stdout.write(`[result_text] ${resultText}\n`);
            } finally {
                await unsubscribe();
            }
        },
    });
}
