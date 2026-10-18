import {
    DuplicateIdempotencyKeyError,
    EVENT_PRIORITY,
    type HostContext,
    type NewEvent,
} from "@getfamiliar/shared";
import {
    type GroupMetadata,
    jidNormalizedUser,
    type WAMessage,
    type WASocket,
} from "@whiskeysockets/baileys";
import {
    extractMessageText,
    formatError,
    normalizeTimestamp,
    type SocketAttacher,
} from "./Connection.js";
import { classifyChatJid, resolveCounterpartNumber } from "./Jid.js";

/** Topic of the event emitted per incoming group text message. */
export const WHATSAPP_GROUP_TOPIC = "chat:whatsapp:group";
/** Topic of the event emitted per direct (one-to-one) text message. */
export const WHATSAPP_DIRECT_TOPIC = "chat:whatsapp:new";

/**
 * Build the `messages.upsert` wiring for the user's personal account:
 * every live group text becomes a `chat:whatsapp:group` event, every
 * live direct text (incoming or sent by the user) a `chat:whatsapp:new`
 * event.
 *
 * Messages exchanged with the agent's own number are skipped — that
 * conversation is the user's chat with the assistant, handled by the
 * agent account as `chat:whatsapp`, and must not be observed twice.
 *
 * @param ctx Host context for config, events and logging.
 * @param agentJids Normalized JIDs (PN and LID) of the agent account;
 *   empty when no agent account is linked.
 * @returns The socket attacher for the user account's connection loop.
 */
export function buildUserAccountAttacher(
    ctx: HostContext,
    agentJids: ReadonlySet<string>,
): SocketAttacher {
    const allowlist = parseGroupAllowlist(ctx.config.getArray("whatsapp.groupAllowlist", null));
    if (allowlist) {
        ctx.logger.info(`whatsapp group allowlist: ${allowlist.join(", ")}`);
    }
    return (sock) => {
        const groupInfoCache = new Map<string, GroupInfo>();
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") {
                // Skip history dumps and replays so re-linking doesn't
                // re-emit a year of chat history into the bus.
                return;
            }
            for (const msg of messages) {
                try {
                    const kind = classifyChatJid(msg.key.remoteJid);
                    if (kind === "group") {
                        await handleGroupMessage(ctx, sock, groupInfoCache, allowlist, msg);
                    } else if (kind === "direct") {
                        await handleDirectMessage(ctx, sock, agentJids, msg);
                    }
                } catch (err) {
                    ctx.logger.info(
                        `whatsapp[user] message handler error (msg ${msg.key.id ?? "?"}): ${formatError(err)}`,
                    );
                }
            }
        });
    };
}

/**
 * Process a single incoming group message. Drops anything that isn't a
 * text in an allowed group; otherwise emits a `chat:whatsapp:group`
 * event.
 */
async function handleGroupMessage(
    ctx: HostContext,
    sock: WASocket,
    groupInfoCache: Map<string, GroupInfo>,
    allowlist: readonly string[] | null,
    msg: WAMessage,
): Promise<void> {
    const remoteJid = msg.key.remoteJid;
    const messageId = msg.key.id;
    if (!remoteJid || !messageId) {
        return;
    }
    if (allowlist && !matchesAllowlist(remoteJid, allowlist)) {
        return;
    }
    const text = extractMessageText(msg);
    if (text === null) {
        // Non-text content (image without caption, audio, sticker,
        // protocol message, etc.). Defer to a later iteration.
        return;
    }
    const { name: groupName, memberCount } = await resolveGroupInfo(
        sock,
        groupInfoCache,
        remoteJid,
        ctx,
    );
    const groupCode = buildGroupCode(groupName);
    const senderJid = msg.key.fromMe
        ? (sock.user?.id ?? null)
        : (msg.key.participant ?? msg.participant ?? null);
    const senderLabel = msg.pushName ?? senderJid ?? "an unknown sender";
    const groupLabel = groupName ?? remoteJid;
    const prompt = msg.key.fromMe
        ? `Our owner sent a message in WhatsApp group "${groupLabel}": ${text}`
        : `A new WhatsApp group message from somebody else: ${senderLabel} in "${groupLabel}" arrived: ${text}`;

    await emitOrSwallow(ctx, {
        topic: WHATSAPP_GROUP_TOPIC,
        isExactTopic: true,
        isChat: false,
        priority: EVENT_PRIORITY.ASYNC,
        idempotencyKey: `whatsapp:${messageId}`,
        prompt,
        payload: {
            text,
            whatsapp: {
                message_id: messageId,
                chat_jid: remoteJid,
                group_jid: remoteJid,
                group_name: groupName,
                group_code: groupCode,
                group_member_count: memberCount,
                from: {
                    jid: senderJid,
                    name: msg.pushName ?? null,
                    is_self: msg.key.fromMe === true,
                },
                timestamp_unix: normalizeTimestamp(msg.messageTimestamp),
                reply_to_message_id: replyToMessageId(msg),
            },
        },
    });
}

/**
 * Process a single direct message — incoming, or sent by the user from
 * another device. Drops non-text content and the conversation with the
 * agent's own number; otherwise emits a `chat:whatsapp:new` event.
 */
async function handleDirectMessage(
    ctx: HostContext,
    sock: WASocket,
    agentJids: ReadonlySet<string>,
    msg: WAMessage,
): Promise<void> {
    const remoteJid = msg.key.remoteJid;
    const messageId = msg.key.id;
    if (!remoteJid || !messageId) {
        return;
    }
    if (isAgentConversation(msg, agentJids)) {
        return;
    }
    const text = extractMessageText(msg);
    if (text === null) {
        return;
    }
    const isSelf = msg.key.fromMe === true;
    const contactNumber = await resolveCounterpartNumber(sock, msg.key);
    // pushName is the *sender's* display name, so it only names the
    // contact when the contact wrote the message.
    const contactName = isSelf ? null : (msg.pushName ?? null);
    const contactLabel = contactName ?? (contactNumber ? `+${contactNumber}` : remoteJid);
    const prompt = isSelf
        ? `Our owner sent a direct WhatsApp message to ${contactLabel}: ${text}`
        : `A new direct WhatsApp message from ${contactLabel}: ${text}`;

    await emitOrSwallow(ctx, {
        topic: WHATSAPP_DIRECT_TOPIC,
        isExactTopic: true,
        isChat: false,
        priority: EVENT_PRIORITY.ASYNC,
        idempotencyKey: `whatsapp:${messageId}`,
        prompt,
        payload: {
            text,
            whatsapp: {
                message_id: messageId,
                chat_jid: remoteJid,
                contact: {
                    jid: remoteJid,
                    number: contactNumber,
                    name: contactName,
                },
                from: {
                    jid: isSelf ? (sock.user?.id ?? null) : remoteJid,
                    name: msg.pushName ?? null,
                    is_self: isSelf,
                },
                timestamp_unix: normalizeTimestamp(msg.messageTimestamp),
                reply_to_message_id: replyToMessageId(msg),
            },
        },
    });
}

/**
 * Whether a direct message belongs to the conversation with the agent
 * account. The chat may be addressed by phone number or by LID, so both
 * `remoteJid` and its `remoteJidAlt` twin are checked.
 */
function isAgentConversation(msg: WAMessage, agentJids: ReadonlySet<string>): boolean {
    if (agentJids.size === 0) {
        return false;
    }
    for (const jid of [msg.key.remoteJid, msg.key.remoteJidAlt]) {
        if (jid && agentJids.has(jidNormalizedUser(jid))) {
            return true;
        }
    }
    return false;
}

/** The id of the message this one quotes, if any. */
function replyToMessageId(msg: WAMessage): string | null {
    return msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null;
}

/**
 * Emit `event`, treating a duplicate idempotency key as a silent no-op
 * (baileys can re-deliver under flaky network) and logging any other
 * failure.
 */
async function emitOrSwallow(ctx: HostContext, event: NewEvent): Promise<void> {
    try {
        await ctx.events.emit(event);
    } catch (err) {
        if (err instanceof DuplicateIdempotencyKeyError) {
            return;
        }
        ctx.logger.info(
            `whatsapp emit failed (${event.topic}, ${event.idempotencyKey}): ${formatError(err)}`,
        );
    }
}

/**
 * Group facts derived from a single `groupMetadata` call: the display
 * name (`subject`) and the current member count (`participants.length`).
 * Both are `null` when the lookup failed.
 */
interface GroupInfo {
    readonly name: string | null;
    readonly memberCount: number | null;
}

/**
 * Best-effort group-info lookup with an in-memory cache. One
 * `groupMetadata` call feeds both the display name and the member
 * count. The cache lives for the lifetime of the socket, so a group
 * rename or membership change takes effect after the next reconnect —
 * acceptable for what are essentially display / heuristic fields. A
 * cached entry with both fields `null` means lookup failed once and we
 * don't want to keep retrying on every message.
 */
async function resolveGroupInfo(
    sock: WASocket,
    cache: Map<string, GroupInfo>,
    jid: string,
    ctx: HostContext,
): Promise<GroupInfo> {
    const cached = cache.get(jid);
    if (cached !== undefined) {
        return cached;
    }
    let metadata: GroupMetadata | undefined;
    try {
        metadata = await sock.groupMetadata(jid);
    } catch (err) {
        ctx.logger.info(`whatsapp groupMetadata(${jid}) failed: ${formatError(err)}`);
    }
    const info: GroupInfo = {
        name: metadata?.subject ?? null,
        memberCount: metadata?.participants?.length ?? null,
    };
    cache.set(jid, info);
    return info;
}

/**
 * Build a filesystem- and identifier-friendly slug from a group name.
 * Useful as a stable handle in workspace paths (`whatsapp/<group_code>/`)
 * and for handlers that want to scope behaviour per group without
 * juggling Unicode names with emoji and umlauts.
 *
 * Rules: spaces collapse to underscores, every other non-`A-Za-z0-9`
 * character is dropped, runs of underscores collapse to one, leading
 * and trailing underscores are trimmed. A name that maps to an empty
 * string (all special chars / emoji) returns `null`, same as a
 * missing name.
 *
 * @example
 *   "MyEO Optimale Vitalität: 💊"  →  "MyEO_Optimale_Vitalitt"
 *   "MyEO German Real Estate"      →  "MyEO_German_Real_Estate"
 *   "🎉🎉🎉"                        →  null
 *
 * @param name The group's display name, or `null` when unknown.
 * @returns The slug, or `null`.
 */
export function buildGroupCode(name: string | null): string | null {
    if (name === null) {
        return null;
    }
    const code = name
        .replace(/\s+/g, "_")
        .replace(/[^A-Za-z0-9_]/g, "")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return code.length === 0 ? null : code;
}

/**
 * Coerce the raw `whatsapp.groupAllowlist` config value to a list of
 * non-empty string entries. `null` / missing returns `null`, meaning
 * "all groups allowed". Each entry is matched against the message's
 * `remoteJid` via `endsWith` so users can write either the full JID
 * (`12345-67890@g.us`) or just the numeric id.
 *
 * Non-string elements are filtered out (loud-but-not-fatal). The
 * config service hands back `unknown[]`, so the plugin owns shape
 * checking.
 */
function parseGroupAllowlist(raw: readonly unknown[] | null): readonly string[] | null {
    if (raw === null) {
        return null;
    }
    const entries = raw
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    if (entries.length === 0) {
        return null;
    }
    return entries;
}

/**
 * `endsWith` match against every allowlist entry. Accepting partial
 * suffixes lets users paste either the full JID or the bare numeric
 * group id from WhatsApp's invite link without thinking about it.
 */
function matchesAllowlist(jid: string, allowlist: readonly string[]): boolean {
    for (const entry of allowlist) {
        if (jid.endsWith(entry)) {
            return true;
        }
    }
    return false;
}
