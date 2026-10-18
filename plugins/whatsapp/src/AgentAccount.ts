import { transcribeAudio } from "@getfamiliar/plugin-transcribe-whisper";
import {
    type ChatUnsubscribe,
    type EmitHandle,
    EVENT_PRIORITY,
    type HostContext,
} from "@getfamiliar/shared";
import { downloadMediaMessage, type WAMessage, type WASocket } from "@whiskeysockets/baileys";
import {
    buildBaileysLogger,
    extractMessageText,
    formatError,
    type SocketAttacher,
    sleep,
    type WhatsAppSocketRegistry,
} from "./Connection.js";
import {
    classifyChatJid,
    isAuthorizedSender,
    normalizePhoneNumber,
    resolveCounterpartNumber,
} from "./Jid.js";

/** Topic of the event emitted per message the user sends to the agent's number. */
export const WHATSAPP_AGENT_TOPIC = "chat:whatsapp";
/** Chat channel id the agent's replies are routed through. */
export const WHATSAPP_CHANNEL = "whatsapp";
const AUTHORIZED_NUMBER_KEY = "whatsapp.agent.authorizedNumber";

/**
 * How often to re-send the `composing` presence while at least one
 * event is still settling. WhatsApp clears the indicator after roughly
 * 25 seconds without a refresh; refreshing well under that keeps it
 * steady.
 */
const TYPING_REFRESH_MS = 10_000;

/**
 * How long an outbound reply waits for the agent socket to come back
 * when it is reconnecting. Past that the message stays undelivered and
 * is replayed on the next daemon start.
 */
const SEND_SOCKET_WAIT_MS = 60_000;
const SEND_SOCKET_POLL_MS = 1000;

/**
 * Pre-attempt delays (ms) for the voice download + transcription retry
 * loop. Length is also the attempt count. Same policy as the Telegram
 * plugin.
 */
const VOICE_RETRY_DELAYS_MS = [0, 5_000, 10_000];

/**
 * Read `whatsapp.agent.authorizedNumber` — the only number the agent
 * account talks to. Accepts both a quoted string and an unquoted YAML
 * number, and normalizes it to bare digits.
 *
 * @param ctx Host context providing the config.
 * @returns The normalized number, or `null` when unset or malformed.
 */
export function readAuthorizedNumber(ctx: HostContext): string | null {
    const asString = ctx.config.getString(AUTHORIZED_NUMBER_KEY, null);
    if (asString !== null) {
        return normalizePhoneNumber(asString);
    }
    const asNumber = ctx.config.getNumber(AUTHORIZED_NUMBER_KEY, null);
    return asNumber === null ? null : normalizePhoneNumber(String(asNumber));
}

/**
 * Build the `messages.upsert` wiring for the agent account: text and
 * voice messages from the authorized number become `chat:whatsapp`
 * chat events; everyone else gets a refusal (or, while no number is
 * configured, a discovery reply naming their number).
 *
 * @param ctx Host context for events and logging.
 * @param authorizedNumber Normalized authorized number, or `null` for
 *   discovery mode.
 * @returns The socket attacher for the agent account's connection loop.
 */
export function buildAgentAccountAttacher(
    ctx: HostContext,
    authorizedNumber: string | null,
): SocketAttacher {
    if (authorizedNumber === null) {
        ctx.logger.info(
            `whatsapp[agent] running in discovery mode (no ${AUTHORIZED_NUMBER_KEY} set); message the agent number to learn yours`,
        );
    } else {
        ctx.logger.info(`whatsapp[agent] authorized number: ${authorizedNumber}`);
    }
    return (sock) => {
        const typing = createTypingTracker(sock, (msg) => ctx.logger.info(msg));
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") {
                return;
            }
            for (const msg of messages) {
                try {
                    await handleAgentMessage(ctx, sock, typing, authorizedNumber, msg);
                } catch (err) {
                    ctx.logger.info(
                        `whatsapp[agent] message handler error (msg ${msg.key.id ?? "?"}): ${formatError(err)}`,
                    );
                }
            }
        });
    };
}

/**
 * Register the outbound chat subscription: assistant replies on the
 * `whatsapp` channel are sent to the authorized number through the
 * current agent socket. The text goes out unchanged — the handler
 * prompt asks the model to write WhatsApp markup directly.
 *
 * @param ctx Host context providing the chat bus.
 * @param registry The agent account's socket registry.
 * @param authorizedNumber Recipient of every reply, or `null` to drop.
 * @returns Disposer that removes the subscription (plugin stop).
 */
export async function subscribeAgentChat(
    ctx: HostContext,
    registry: WhatsAppSocketRegistry,
    authorizedNumber: string | null,
): Promise<ChatUnsubscribe> {
    return await ctx.chat.subscribe(
        { channelId: WHATSAPP_CHANNEL, role: "assistant" },
        async (m) => {
            if (authorizedNumber === null) {
                ctx.logger.info(
                    `dropping whatsapp assistant msg ${m.id}: no ${AUTHORIZED_NUMBER_KEY} set`,
                );
                return true;
            }
            const sock = await waitForSocket(registry);
            if (sock === null) {
                // Leave it undelivered; the subscription replays it on the
                // next daemon start.
                ctx.logger.info(
                    `whatsapp[agent] socket offline for ${SEND_SOCKET_WAIT_MS}ms; leaving assistant msg ${m.id} undelivered`,
                );
                return false;
            }
            try {
                await sock.sendMessage(`${authorizedNumber}@s.whatsapp.net`, {
                    text: m.textContent,
                });
            } catch (err) {
                // Ack anyway: returning false would replay forever on
                // permanent failures.
                ctx.logger.info(`whatsapp[agent] send of msg ${m.id} failed: ${formatError(err)}`);
            }
            return true;
        },
    );
}

/**
 * Process a single message arriving at the agent account.
 */
async function handleAgentMessage(
    ctx: HostContext,
    sock: WASocket,
    typing: TypingTracker,
    authorizedNumber: string | null,
    msg: WAMessage,
): Promise<void> {
    const chatJid = msg.key.remoteJid;
    const messageId = msg.key.id;
    // Our own replies echo back as fromMe; groups and broadcasts the
    // agent number might be added to are not conversations with the user.
    if (msg.key.fromMe || !chatJid || !messageId || classifyChatJid(chatJid) !== "direct") {
        return;
    }
    if (!msg.message || msg.message.protocolMessage || msg.message.reactionMessage) {
        return;
    }
    const senderNumber = await resolveCounterpartNumber(sock, msg.key);
    if (authorizedNumber === null) {
        await reply(
            sock,
            chatJid,
            `Not authorized. Your number is ${senderNumber ?? "unknown"}. Set ${AUTHORIZED_NUMBER_KEY}: "${senderNumber ?? "<your number>"}" in config/config.yml and restart.`,
        );
        return;
    }
    if (!isAuthorizedSender(senderNumber, authorizedNumber)) {
        ctx.logger.info(
            `whatsapp[agent] refusing msg ${messageId} from unauthorized sender ${senderNumber ?? chatJid}`,
        );
        await reply(sock, chatJid, "Sorry, I only talk to my owner.");
        return;
    }

    const em: AgentEmitContext = { ctx, sock, typing, msg, chatJid, messageId, senderNumber };
    const text = extractMessageText(msg);
    if (text !== null) {
        await markRead(em);
        void emitAgentChatEvent(em, text);
        return;
    }
    const audio = msg.message.audioMessage;
    if (audio?.ptt) {
        await markRead(em);
        const transcript = await transcribeVoice(em);
        if (transcript === undefined) {
            await reply(
                sock,
                chatJid,
                "Sorry, I couldn't transcribe your voice message — please try again or send text.",
            );
            return;
        }
        if (transcript.length === 0) {
            await reply(
                sock,
                chatJid,
                "Your voice message transcribed to nothing — was it silent?",
            );
            return;
        }
        void emitAgentChatEvent(em, `[Transcribed voice message]\n${transcript}`, {
            voice: {
                duration: audio.seconds ?? null,
                mime_type: audio.mimetype ?? null,
                transcript,
            },
        });
        return;
    }
    await reply(sock, chatJid, "Only text and voice messages are supported right now.");
}

/**
 * Everything the emit / voice helpers need about one accepted message.
 */
interface AgentEmitContext {
    readonly ctx: HostContext;
    readonly sock: WASocket;
    readonly typing: TypingTracker;
    readonly msg: WAMessage;
    readonly chatJid: string;
    readonly messageId: string;
    readonly senderNumber: string | null;
}

/**
 * Emit a `chat:whatsapp` event for an accepted message and keep the
 * typing indicator alive until the resulting agentrun settles. Designed
 * for fire-and-forget at the call site so the socket's event loop isn't
 * coupled to multi-second agent runs.
 *
 * @param em The accepted message's context.
 * @param text Agent-visible text; becomes the prompt and the chat message.
 * @param extras Entries merged into `payload.whatsapp` (e.g. `voice`).
 */
async function emitAgentChatEvent(
    em: AgentEmitContext,
    text: string,
    extras?: Record<string, unknown>,
): Promise<void> {
    let handle: EmitHandle;
    try {
        handle = await em.ctx.events.emit({
            topic: WHATSAPP_AGENT_TOPIC,
            isChat: true,
            priority: EVENT_PRIORITY.CHAT,
            preferredChatChannelId: WHATSAPP_CHANNEL,
            idempotencyKey: `whatsapp-agent:${em.messageId}`,
            prompt: text,
            // Reaches here only after the sender matched the configured
            // authorized number, so the agentrun tree may use
            // privileged-only system tools.
            privileged: true,
            // Route agentrun failures through chatmessages so the user
            // sees them in WhatsApp like a normal reply.
            outputChatOnFailure: true,
            payload: {
                whatsapp: {
                    message_id: em.messageId,
                    from: {
                        jid: em.chatJid,
                        number: em.senderNumber,
                        name: em.msg.pushName ?? null,
                    },
                    ...extras,
                },
            },
        });
    } catch (err) {
        em.ctx.logger.info(
            `whatsapp[agent] emit failed (msg ${em.messageId}): ${formatError(err)}`,
        );
        return;
    }

    em.typing.track(handle.id, em.chatJid);
    try {
        await handle.settled;
    } catch (err) {
        em.ctx.logger.info(`whatsapp[agent] event ${handle.id} failed: ${formatError(err)}`);
    } finally {
        em.typing.untrack(handle.id);
    }
}

/**
 * Download and transcribe a voice note, retrying transient failures.
 *
 * @param em The accepted message's context.
 * @returns The trimmed transcript, or `undefined` when every attempt failed.
 */
async function transcribeVoice(em: AgentEmitContext): Promise<string | undefined> {
    let lastError: unknown;
    for (let attempt = 0; attempt < VOICE_RETRY_DELAYS_MS.length; attempt++) {
        const delay = VOICE_RETRY_DELAYS_MS[attempt];
        if (delay > 0) {
            await sleep(delay);
        }
        try {
            const audio = await downloadMediaMessage(
                em.msg,
                "buffer",
                {},
                { logger: buildBaileysLogger(em.ctx), reuploadRequest: em.sock.updateMediaMessage },
            );
            return (await transcribeAudio(audio, "voice.ogg")).trim();
        } catch (err) {
            lastError = err;
            em.ctx.logger.info(
                `whatsapp[agent] voice transcription attempt ${attempt + 1}/${VOICE_RETRY_DELAYS_MS.length} for msg ${em.messageId} failed: ${formatError(err)}`,
            );
        }
    }
    em.ctx.logger.info(
        `whatsapp[agent] voice transcription for msg ${em.messageId} failed: ${formatError(lastError)}`,
    );
    return undefined;
}

/**
 * Send the user a read receipt (blue ticks) for an accepted message.
 * Best effort — a failure is logged and otherwise ignored.
 */
async function markRead(em: AgentEmitContext): Promise<void> {
    try {
        await em.sock.readMessages([em.msg.key]);
    } catch (err) {
        em.ctx.logger.info(
            `whatsapp[agent] read receipt for msg ${em.messageId} failed: ${formatError(err)}`,
        );
    }
}

/**
 * Send a plain system reply (refusals, unsupported-content notices).
 */
async function reply(sock: WASocket, jid: string, text: string): Promise<void> {
    await sock.sendMessage(jid, { text });
}

/**
 * Wait up to {@link SEND_SOCKET_WAIT_MS} for the agent socket to be
 * connected.
 *
 * @returns The connected socket, or `null` when it stayed offline.
 */
async function waitForSocket(registry: WhatsAppSocketRegistry): Promise<WASocket | null> {
    const deadline = Date.now() + SEND_SOCKET_WAIT_MS;
    while (true) {
        const sock = registry.current();
        if (sock !== null || Date.now() >= deadline) {
            return sock;
        }
        await sleep(SEND_SOCKET_POLL_MS);
    }
}

/**
 * Tracks event ids whose agentruns are still in flight and keeps a
 * `composing` presence alive in their chat for as long as any is
 * pending. Mirrors the Telegram plugin's tracker.
 */
interface TypingTracker {
    /** Start (or extend) the typing indicator in `jid` for `eventId`. */
    track(eventId: string, jid: string): void;
    /** Stop tracking `eventId`; sends `paused` once its chat has nothing pending. */
    untrack(eventId: string): void;
}

/**
 * Build a {@link TypingTracker} bound to one socket. The refresh
 * interval runs for the socket's lifetime and issues no calls while
 * nothing is in flight; it stops once the socket's connection closes.
 */
function createTypingTracker(sock: WASocket, log: (message: string) => void): TypingTracker {
    const inFlight = new Map<string, string>();
    const send = (presence: "composing" | "paused", jid: string): void => {
        sock.sendPresenceUpdate(presence, jid).catch((err) => {
            log(`whatsapp[agent] ${presence} presence failed: ${formatError(err)}`);
        });
    };
    const interval = setInterval(() => {
        for (const jid of new Set(inFlight.values())) {
            send("composing", jid);
        }
    }, TYPING_REFRESH_MS);
    sock.ev.on("connection.update", (update) => {
        if (update.connection === "close") {
            clearInterval(interval);
        }
    });
    return {
        track(eventId, jid) {
            inFlight.set(eventId, jid);
            send("composing", jid);
        },
        untrack(eventId) {
            const jid = inFlight.get(eventId);
            inFlight.delete(eventId);
            if (jid !== undefined && ![...inFlight.values()].includes(jid)) {
                send("paused", jid);
            }
        },
    };
}
