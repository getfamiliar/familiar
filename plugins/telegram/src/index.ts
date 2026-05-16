import path from "node:path";
import { definePlugin } from "@getfamiliar/shared";
import { buildCommands } from "./Commands.js";
import { startTelegramDaemon } from "./TelegramDaemon.js";

/**
 * Telegram host-side plugin.
 *
 * Bridges a Telegram bot (via grammy long-polling) to the assistant's
 * chat pipeline:
 *
 * - **Inbound**: text messages from the authorized user become
 *   `chat:telegram` events with `isChat=true` and
 *   `preferredChatChannelId="telegram"`. Idempotency key is
 *   `telegram:<update_id>`.
 * - **Outbound**: a `ctx.chat.subscribe` on
 *   `{channelId: "telegram", role: "assistant"}` posts the agent's
 *   replies back to the authorized user via `bot.api.sendMessage`.
 *
 * Authorization is strict-env: `TELEGRAM_BOT_TOKEN` is required;
 * `TELEGRAM_AUTHORIZED_USER_ID` is optional. With token only, the
 * bot runs in "discovery mode" and replies to any sender with their
 * own numeric id, so the operator can paste it into `.env` without
 * needing an out-of-band lookup.
 *
 * The plugin self-disables (no host impact) when `TELEGRAM_BOT_TOKEN`
 * is unset.
 */
export default definePlugin({
    id: "telegram",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    host: {
        start: (ctx) => startTelegramDaemon(ctx),
        commands: (ctx) => buildCommands(ctx),
    },
});
