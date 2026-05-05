import type { HostContext } from "effective-assistant-shared";
import { Bot, GrammyError, HttpError } from "grammy";

const TELEGRAM_CHANNEL = "telegram";
const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Resolved telegram configuration. `authorizedUserId === null` means
 * the token is configured but the user id is not — the bot still runs
 * in "discovery mode" so it can disclose senders' numeric ids.
 */
export interface TelegramConfig {
    readonly token: string;
    readonly authorizedUserId: number | null;
}

/**
 * Read `TELEGRAM_BOT_TOKEN` and `TELEGRAM_AUTHORIZED_USER_ID` from
 * `process.env`. Returns `null` when the token is missing — the plugin
 * self-disables in that case rather than bringing the host down.
 *
 * The user id is optional: if absent or unparseable, returns
 * `authorizedUserId: null`, putting the bot into discovery mode.
 *
 * @returns Config object, or `null` when the bot should not start.
 */
export function readTelegramConfig(): TelegramConfig | null {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        return null;
    }
    return {
        token,
        authorizedUserId: parseAuthorizedUserId(process.env.TELEGRAM_AUTHORIZED_USER_ID),
    };
}

/**
 * Parse a positive integer from the env value. Returns `null` for
 * unset, empty, non-numeric, or non-positive values. Callers treat
 * `null` as "discovery mode".
 */
function parseAuthorizedUserId(raw: string | undefined): number | null {
    if (!raw) {
        return null;
    }
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
        return null;
    }
    return n;
}

/**
 * Start the Telegram bot daemon: validate config, register grammy
 * handlers, register the outbound chat subscription, and kick off
 * long-polling without awaiting it.
 *
 * Resolves once registration is complete (the polling loop runs in
 * the background) so the plugin host's `startDaemons` doesn't block
 * on a never-resolving promise. Errors during long-polling are caught
 * and logged; the host stays up regardless.
 *
 * Self-disables (returns early after a log line) when
 * `TELEGRAM_BOT_TOKEN` is unset, so users without telegram configured
 * see no impact.
 */
export async function startTelegramDaemon(ctx: HostContext): Promise<void> {
    const config = readTelegramConfig();
    if (!config) {
        ctx.log("telegram disabled: TELEGRAM_BOT_TOKEN not set");
        return;
    }
    const { token, authorizedUserId } = config;

    const bot = new Bot(token);

    // Fail fast on bad token. Don't crash the host — log and bail.
    let me: Awaited<ReturnType<typeof bot.api.getMe>>;
    try {
        me = await bot.api.getMe();
    } catch (err) {
        ctx.log(`telegram disabled: getMe failed: ${formatError(err)}`);
        return;
    }

    if (authorizedUserId === null) {
        ctx.log(
            `telegram running in discovery mode (no TELEGRAM_AUTHORIZED_USER_ID set); message @${me.username} to learn your id`,
        );
    } else {
        ctx.log(`telegram authorized user id: ${authorizedUserId}`);
    }

    bot.on("message:text", async (gctx) => {
        if (gctx.chat.type !== "private") {
            return;
        }
        const senderId = gctx.from?.id;
        if (senderId === undefined) {
            return;
        }

        if (authorizedUserId === null) {
            await gctx.reply(
                `Not authorized. Your user id is ${senderId}. Add TELEGRAM_AUTHORIZED_USER_ID=${senderId} to .env and restart.`,
            );
            return;
        }
        if (senderId !== authorizedUserId) {
            await gctx.reply(`Won't talk to you, user with id ${senderId}.`);
            return;
        }

        const updateId = gctx.update.update_id;
        // Fire-and-forget. ctx.events.emit blocks until the agentrun
        // settles, which can take many seconds; we must not gate
        // grammy's polling loop on that.
        ctx.events
            .emit({
                topic: "chat:telegram",
                isChat: true,
                preferredChatChannelId: TELEGRAM_CHANNEL,
                idempotencyKey: `telegram:${updateId}`,
                payload: {
                    text: gctx.message.text,
                    telegram: {
                        update_id: updateId,
                        message_id: gctx.message.message_id,
                        from: { id: senderId, username: gctx.from.username },
                    },
                },
            })
            .catch((err) => {
                ctx.log(`telegram emit failed (update ${updateId}): ${formatError(err)}`);
            });
    });

    bot.on("message", async (gctx) => {
        if (gctx.chat.type !== "private") {
            return;
        }
        const senderId = gctx.from?.id;
        if (senderId === undefined) {
            return;
        }
        if (authorizedUserId === null) {
            await gctx.reply(
                `Not authorized. Your user id is ${senderId}. Add TELEGRAM_AUTHORIZED_USER_ID=${senderId} to .env and restart.`,
            );
            return;
        }
        if (senderId !== authorizedUserId) {
            await gctx.reply(`Won't talk to you, user with id ${senderId}.`);
            return;
        }
        await gctx.reply("Only text messages are supported right now.");
    });

    await ctx.chat.subscribe({ channelId: TELEGRAM_CHANNEL, role: "assistant" }, async (m) => {
        if (authorizedUserId === null) {
            ctx.log("dropping telegram assistant msg: no TELEGRAM_AUTHORIZED_USER_ID");
            return true;
        }
        try {
            for (const chunk of splitForTelegram(m.textContent)) {
                await bot.api.sendMessage(authorizedUserId, chunk);
            }
        } catch (err) {
            // Ack anyway: returning false would replay forever on
            // permanent failures (user blocked the bot, etc.).
            // Bounded retry is a future enhancement.
            ctx.log(`telegram send failed: ${formatError(err)}`);
        }
        return true;
    });

    // Don't await: bot.start() long-polls forever and only resolves on
    // bot.stop(). Errors propagate via the .catch below.
    bot.start({
        onStart: (info) => ctx.log(`telegram online as @${info.username}`),
    }).catch((err) => {
        ctx.log(`telegram poll loop crashed: ${formatError(err)}`);
    });
}

/**
 * Split `text` into chunks that fit Telegram's 4096-character per-
 * message limit. Prefers paragraph boundaries (`\n\n`), falls back to
 * single newlines, and finally hard-cuts mid-paragraph if a single
 * line is itself longer than the limit.
 *
 * Always returns at least one chunk. Empty/whitespace input returns
 * an array with one empty string — the caller decides whether to send
 * it.
 */
export function splitForTelegram(text: string): string[] {
    if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
        return [text];
    }
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
        const slice = remaining.slice(0, TELEGRAM_MESSAGE_LIMIT);
        const breakAt = pickBreakpoint(slice);
        chunks.push(remaining.slice(0, breakAt).trimEnd());
        remaining = remaining.slice(breakAt).trimStart();
    }
    if (remaining.length > 0) {
        chunks.push(remaining);
    }
    return chunks;
}

/**
 * Find a clean breakpoint inside `slice` (length ≤ limit). Tries
 * `\n\n`, then `\n`, then space; if none is reasonably late in the
 * slice (past 50 %), hard-cuts at the limit.
 */
function pickBreakpoint(slice: string): number {
    const minIndex = Math.floor(slice.length / 2);
    const candidates = ["\n\n", "\n", " "] as const;
    for (const sep of candidates) {
        const at = slice.lastIndexOf(sep);
        if (at >= minIndex) {
            return at + sep.length;
        }
    }
    return slice.length;
}

/**
 * Render an unknown thrown value as a short diagnostic string.
 * Surfaces grammy's structured error metadata (description, status)
 * when available so log lines are actionable.
 */
function formatError(err: unknown): string {
    if (err instanceof GrammyError) {
        return `GrammyError ${err.error_code}: ${err.description}`;
    }
    if (err instanceof HttpError) {
        return `HttpError: ${err.message}`;
    }
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}
