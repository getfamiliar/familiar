import { type CommandDef, defineCommand } from "citty";
import type { HostContext } from "effective-assistant-shared";
import { Bot, GrammyError } from "grammy";
import { readTelegramConfig, splitForTelegram } from "./TelegramDaemon.js";

/**
 * Build the citty subcommands exposed under `./cli.sh telegram`.
 *
 * Each subcommand re-reads env on invocation rather than capturing a
 * snapshot from the daemon — invoking the CLI typically happens in a
 * separate process from the running daemon, so config must come from
 * `.env` either way.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
export function buildCommands(ctx: HostContext): readonly CommandDef<any>[] {
    return [statusCommand(ctx), sendCommand(ctx)];
}

/**
 * `./cli.sh telegram status` — print token presence, bot identity (via
 * a live `getMe` when the token is set), authorization state, and a
 * pointer to `DEFAULT_CHAT_CHANNEL_ID`. Read-only; no side effects.
 */
function statusCommand(_ctx: HostContext) {
    return defineCommand({
        meta: {
            name: "status",
            description: "Show Telegram plugin configuration and bot identity.",
        },
        async run() {
            const config = readTelegramConfig();
            if (!config) {
                process.stdout.write("Telegram disabled: TELEGRAM_BOT_TOKEN not set.\n");
                return;
            }
            const tokenSummary = `${config.token.slice(0, 6)}…${config.token.slice(-4)}`;
            process.stdout.write(`Token configured: ${tokenSummary}\n`);

            const bot = new Bot(config.token);
            try {
                const me = await bot.api.getMe();
                process.stdout.write(`Bot username: @${me.username} (id ${me.id})\n`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stdout.write(`Bot identity: getMe failed (${msg})\n`);
            }

            if (config.authorizedUserId === null) {
                process.stdout.write(
                    "Authorized user id: discovery mode — message the bot to learn yours.\n",
                );
            } else {
                process.stdout.write(`Authorized user id: ${config.authorizedUserId}\n`);
            }
            process.stdout.write(
                "\nTip: set DEFAULT_CHAT_CHANNEL_ID=telegram in .env so workflow-triggered\n" +
                    "proactive messages route to Telegram by default.\n",
            );
        },
    });
}

/**
 * `./cli.sh telegram send "<text>"` — direct Bot API push to the
 * authorized user. Useful as a smoke test that the token + user id
 * combination is wired up. Bypasses the chatmessages pipeline, so
 * messages sent this way do NOT appear in the agent's chat history.
 */
function sendCommand(_ctx: HostContext) {
    return defineCommand({
        meta: {
            name: "send",
            description:
                "Send a message directly via the Telegram Bot API (test-only; not recorded in chat history).",
        },
        args: {
            text: {
                type: "positional",
                required: true,
                description: "Message text to send.",
            },
        },
        async run({ args }) {
            const config = readTelegramConfig();
            if (!config) {
                process.stderr.write("Telegram disabled: TELEGRAM_BOT_TOKEN not set in .env.\n");
                process.exit(1);
            }
            if (config.authorizedUserId === null) {
                process.stderr.write(
                    "Cannot send: TELEGRAM_AUTHORIZED_USER_ID is not set. " +
                        "Set it in .env (run `./cli.sh telegram status` for guidance).\n",
                );
                process.exit(1);
            }
            const bot = new Bot(config.token);
            try {
                for (const chunk of splitForTelegram(args.text)) {
                    await bot.api.sendMessage(config.authorizedUserId, chunk);
                }
                process.stdout.write("sent\n");
            } catch (err) {
                const msg =
                    err instanceof GrammyError
                        ? `GrammyError ${err.error_code}: ${err.description}`
                        : err instanceof Error
                          ? err.message
                          : String(err);
                process.stderr.write(`send failed: ${msg}\n`);
                process.exit(1);
            }
        },
    });
}
