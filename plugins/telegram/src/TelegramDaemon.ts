import type { HostContext } from "effective-assistant-shared";
import { Bot, type Context, GrammyError, HttpError } from "grammy";
import { transcribeAudio } from "transcribe-whisper";

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
        if (!(await isChatAllowed(gctx, authorizedUserId))) {
            return;
        }
        emitChatEvent(ctx, gctx, gctx.message.text);
    });

    bot.on("message:sticker", async (gctx) => {
        if (!(await isChatAllowed(gctx, authorizedUserId))) {
            return;
        }
        const sticker = gctx.message.sticker;
        const emoji = sticker.emoji;
        if (emoji === undefined) {
            await gctx.reply(
                "I can't read this sticker — it has no associated emoji to fall back to.",
            );
            return;
        }
        emitChatEvent(ctx, gctx, emoji, {
            sticker: {
                emoji,
                set_name: sticker.set_name,
                is_animated: sticker.is_animated,
                is_video: sticker.is_video,
            },
        });
    });

    bot.on("message:voice", async (gctx) => {
        if (!(await isChatAllowed(gctx, authorizedUserId))) {
            return;
        }
        const voice = gctx.message.voice;
        let transcript: string;
        try {
            const audio = await downloadTelegramFile(bot, token, voice.file_id);
            transcript = (await transcribeAudio(audio, "voice.ogg")).trim();
        } catch (err) {
            ctx.log(`telegram voice transcription failed: ${formatError(err)}`);
            await gctx.reply(
                "Sorry, I couldn't transcribe your voice message — please try again or send text.",
            );
            return;
        }
        if (transcript.length === 0) {
            await gctx.reply("Your voice message transcribed to nothing — was it silent?");
            return;
        }
        emitChatEvent(ctx, gctx, `[Transcribed voice message]\n${transcript}`, {
            voice: {
                duration: voice.duration,
                file_id: voice.file_id,
                mime_type: voice.mime_type,
                transcript,
            },
        });
    });

    bot.on("message", async (gctx) => {
        if (!(await isChatAllowed(gctx, authorizedUserId))) {
            return;
        }
        await gctx.reply("Only text, sticker, and voice messages are supported right now.");
    });

    await ctx.chat.subscribe({ channelId: TELEGRAM_CHANNEL, role: "assistant" }, async (m) => {
        if (authorizedUserId === null) {
            ctx.log("dropping telegram assistant msg: no TELEGRAM_AUTHORIZED_USER_ID");
            return true;
        }
        try {
            for (const chunk of splitForTelegram(m.textContent)) {
                await sendWithMarkdownFallback(bot, authorizedUserId, chunk, (msg) => ctx.log(msg));
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
 * Emit a `chat:telegram` event for the given Telegram update.
 *
 * Centralizes the boilerplate every per-message-type handler shares:
 * topic, channel, idempotency key derived from `update_id`, and the
 * standard `payload.telegram` envelope (`update_id`, `message_id`,
 * `from`). Per-type handlers pass the agent-visible `text` plus an
 * optional `telegramExtras` map whose entries are merged into
 * `payload.telegram` (e.g. `{ sticker: { emoji, set_name, … } }`).
 *
 * Fire-and-forget: `ctx.events.emit` blocks until the agentrun
 * settles, which we must not couple to grammy's polling loop.
 * Failures are logged via `ctx.log`.
 *
 * Callers must invoke this only after `isChatAllowed` has returned
 * `true` — that's what guarantees `gctx.message` and `gctx.from` are
 * present. The defensive guard inside is a TypeScript belt-and-braces.
 */
function emitChatEvent(
    ctx: HostContext,
    gctx: Context,
    text: string,
    telegramExtras?: Record<string, unknown>,
): void {
    const message = gctx.message;
    const from = gctx.from;
    if (message === undefined || from === undefined) {
        return;
    }
    const updateId = gctx.update.update_id;
    ctx.events
        .emit({
            topic: "chat:telegram",
            isChat: true,
            preferredChatChannelId: TELEGRAM_CHANNEL,
            idempotencyKey: `telegram:${updateId}`,
            payload: {
                text,
                telegram: {
                    update_id: updateId,
                    message_id: message.message_id,
                    from: { id: from.id, username: from.username },
                    ...telegramExtras,
                },
            },
        })
        .catch((err) => {
            ctx.log(`telegram emit failed (update ${updateId}): ${formatError(err)}`);
        });
}

/**
 * Decide whether a Telegram update should be processed by the
 * authorized-user pipeline. Centralizes the gate shared by every
 * `bot.on(...)` handler so each handler only declares what it does
 * with allowed messages.
 *
 * Outcomes:
 * - **Silently rejects** non-private chats and updates with no
 *   identifiable sender. No reply — those cases shouldn't reveal
 *   the bot's behavior to scanners or to group chats it was added to.
 * - **Replies and rejects** when the bot is configured but no
 *   `TELEGRAM_AUTHORIZED_USER_ID` is set: tells the sender their
 *   numeric id so the operator can paste it into `.env`.
 * - **Replies and rejects** when the sender is not the authorized
 *   user.
 * - **Allows** when the sender matches `authorizedUserId`.
 *
 * @returns `true` when the handler should continue processing,
 *   `false` when it must early-return. Side-effecting replies are
 *   sent before `false` is returned, so callers don't need to.
 */
async function isChatAllowed(gctx: Context, authorizedUserId: number | null): Promise<boolean> {
    if (gctx.chat?.type !== "private") {
        return false;
    }
    const senderId = gctx.from?.id;
    if (senderId === undefined) {
        return false;
    }
    if (authorizedUserId === null) {
        await gctx.reply(
            `Not authorized. Your user id is ${senderId}. Add TELEGRAM_AUTHORIZED_USER_ID=${senderId} to .env and restart.`,
        );
        return false;
    }
    if (senderId !== authorizedUserId) {
        await gctx.reply(`Won't talk to you, user with id ${senderId}.`);
        return false;
    }
    return true;
}

/**
 * Resolve a Telegram `file_id` to its CDN URL via `getFile`, then
 * download the bytes into a Buffer. Used to fetch voice notes (and
 * any future audio/video/document) for in-process processing such
 * as transcription.
 *
 * Telegram's getFile-then-download dance is required because the
 * Bot API only hands out a `file_path` plus the implicit URL pattern
 * `https://api.telegram.org/file/bot<token>/<file_path>`. The token
 * embedded in the URL must be kept on the host — that's why this
 * helper lives in the plugin (which already has the token in scope)
 * rather than in `transcribe-whisper`.
 *
 * @throws If the `getFile` call fails, the file has no `file_path`
 *   (rare; happens for very large files), or the HTTP download
 *   returns a non-2xx status.
 */
async function downloadTelegramFile(bot: Bot, token: string, fileId: string): Promise<Buffer> {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
        throw new Error(`Telegram getFile returned no file_path for id ${fileId}`);
    }
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            `Telegram file download failed: HTTP ${response.status} ${response.statusText}`,
        );
    }
    return Buffer.from(await response.arrayBuffer());
}

/**
 * Send `text` as a Telegram message, attempting MarkdownV2 first and
 * silently falling back to plain text if Telegram rejects the entity
 * parse. The fallback path covers the realistic case where the agent
 * emits markdown that almost-but-not-quite conforms to MarkdownV2's
 * escaping rules (a bare `.`, an unmatched `_`, etc.) — better to
 * deliver an unformatted message than swallow it.
 *
 * Other error classes (network, 401, blocked-by-user) are re-thrown
 * so the caller's broader `try/catch` handles them uniformly.
 */
export async function sendWithMarkdownFallback(
    bot: Bot,
    chatId: number,
    text: string,
    log: (message: string) => void,
): Promise<void> {
    try {
        await bot.api.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
    } catch (err) {
        if (!isMarkdownParseError(err)) {
            throw err;
        }
        log(`telegram MarkdownV2 parse failed; resending as plain text: ${formatError(err)}`);
        await bot.api.sendMessage(chatId, text);
    }
}

/**
 * Detect Telegram's "can't parse entities" 400 response, which is
 * what `sendMessage` returns when MarkdownV2 syntax is malformed.
 * Distinct from other 400s (e.g. "message is too long") which should
 * propagate.
 */
function isMarkdownParseError(err: unknown): boolean {
    return (
        err instanceof GrammyError &&
        err.error_code === 400 &&
        err.description.includes("can't parse entities")
    );
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
