import { Boom } from "@hapi/boom";
import {
    DisconnectReason,
    type GroupMetadata,
    default as makeWASocket,
    type WAMessage,
    type WASocket,
} from "@whiskeysockets/baileys";
import type { HostContext } from "effective-assistant-shared";
import { clearAuth, loadAuth, type WhatsAppAuth } from "./Auth";

const TOPIC = "chat:whatsapp:group";
const GROUP_JID_SUFFIX = "@g.us";
const RECONNECT_BACKOFF_MIN_MS = 1000;
const RECONNECT_BACKOFF_MAX_MS = 5 * 60 * 1000;
/**
 * `userAgent` advertised to the WhatsApp servers when this device
 * registers. Showing up in the user's "Linked devices" UI as
 * "effective-assistant" makes the link easy to recognize and revoke.
 */
const BROWSER_DESCRIPTION: [string, string, string] = ["effective-assistant", "Chrome", "1.0"];

/**
 * Start the WhatsApp daemon. Mirrors the telegram pattern: validate
 * config, register handlers, kick off the long-running connection
 * loop without awaiting it.
 *
 * Self-disables (returns after one log line) when the device hasn't
 * been linked yet — there's no env-var enable flag; presence of
 * baileys credentials on disk *is* the on/off switch. The user runs
 * `./cli.sh whatsapp link` once to pair, and from then on every
 * `./cli.sh start` re-uses the persisted creds without prompting.
 */
export async function startWhatsAppDaemon(ctx: HostContext): Promise<void> {
    const auth = await loadAuth(ctx);
    if (!auth.hasExistingCreds) {
        ctx.log("whatsapp not linked yet; run `./cli.sh whatsapp link` to pair this device");
        return;
    }
    // Long-lived; never resolves under normal operation. Detach so the
    // host's `startDaemons` chain doesn't block on it.
    void runConnectionLoop(ctx, auth);
}

/**
 * Forever-loop that owns one baileys socket at a time. Reconnects with
 * exponential backoff on any close other than `loggedOut`. On
 * `loggedOut`, wipes auth and exits the loop — the user must re-link
 * the device before another connection makes sense.
 */
async function runConnectionLoop(ctx: HostContext, auth: WhatsAppAuth): Promise<void> {
    const allowlist = parseGroupAllowlist(process.env.WHATSAPP_GROUP_ALLOWLIST);
    if (allowlist) {
        ctx.log(`whatsapp group allowlist: ${allowlist.join(", ")}`);
    }
    let backoffMs = RECONNECT_BACKOFF_MIN_MS;
    while (true) {
        const reason = await runConnection(ctx, auth, allowlist);
        if (reason === "loggedOut") {
            ctx.log(
                "whatsapp logged out (device removed from phone); clearing auth and stopping. Run `./cli.sh whatsapp link` to re-pair.",
            );
            await clearAuth(ctx);
            return;
        }
        ctx.log(`whatsapp disconnected (${reason}); reconnecting in ${backoffMs}ms`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
    }
}

/**
 * Run a single baileys session: build the socket, attach handlers,
 * and resolve when the connection closes. The resolved value is
 * either `"loggedOut"` (terminal — caller must wipe auth) or any
 * other string description suitable for log output.
 *
 * On a successful `open`, the backoff counter is reset by the caller
 * via the `onOpen` callback.
 */
async function runConnection(
    ctx: HostContext,
    auth: WhatsAppAuth,
    allowlist: readonly string[] | null,
): Promise<"loggedOut" | string> {
    const sock = makeWASocket({
        auth: auth.state,
        printQRInTerminal: false,
        browser: BROWSER_DESCRIPTION,
    });
    sock.ev.on("creds.update", auth.saveCreds);

    const groupNameCache = new Map<string, string | null>();
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") {
            // Skip history dumps and replays so re-linking doesn't
            // re-emit a year of group chat into the bus.
            return;
        }
        for (const msg of messages) {
            try {
                await handleIncomingMessage(ctx, sock, groupNameCache, allowlist, msg);
            } catch (err) {
                ctx.log(`whatsapp message handler error: ${formatError(err)}`);
            }
        }
    });

    return await new Promise<"loggedOut" | string>((resolve) => {
        sock.ev.on("connection.update", (update) => {
            if (update.connection === "open") {
                const me = sock.user?.id ?? "unknown";
                ctx.log(`whatsapp online as ${me}`);
                return;
            }
            if (update.connection === "close") {
                const err = update.lastDisconnect?.error;
                const statusCode = extractStatusCode(err);
                if (statusCode === DisconnectReason.loggedOut) {
                    resolve("loggedOut");
                    return;
                }
                resolve(`statusCode=${statusCode ?? "unknown"}: ${formatError(err)}`);
            }
        });
    });
}

/**
 * Process a single incoming WhatsApp message. Drops anything that
 * isn't a live group text; otherwise emits a `chat:whatsapp:group`
 * event with the agreed payload shape.
 *
 * Idempotency uses `whatsapp:<message_id>`. Collisions (rare —
 * baileys can re-deliver under flaky network) become silent no-ops
 * because the postgres unique constraint trips and {@link emitOrSwallow}
 * swallows the duplicate-key error.
 */
async function handleIncomingMessage(
    ctx: HostContext,
    sock: WASocket,
    groupNameCache: Map<string, string | null>,
    allowlist: readonly string[] | null,
    msg: WAMessage,
): Promise<void> {
    const remoteJid = msg.key.remoteJid;
    if (!remoteJid?.endsWith(GROUP_JID_SUFFIX)) {
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
    const messageId = msg.key.id;
    if (!messageId) {
        return;
    }
    const groupName = await resolveGroupName(sock, groupNameCache, remoteJid, ctx);
    const senderJid = msg.key.fromMe
        ? (sock.user?.id ?? null)
        : (msg.key.participant ?? msg.participant ?? null);
    const timestamp = normalizeTimestamp(msg.messageTimestamp);
    const replyTo = msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null;

    try {
        await ctx.events.emit({
            topic: TOPIC,
            isChat: false,
            preferredChatChannelId: null,
            idempotencyKey: `whatsapp:${messageId}`,
            payload: {
                text,
                whatsapp: {
                    message_id: messageId,
                    group_jid: remoteJid,
                    group_name: groupName,
                    from: {
                        jid: senderJid,
                        push_name: msg.pushName ?? null,
                        is_self: msg.key.fromMe === true,
                    },
                    timestamp_unix: timestamp,
                    reply_to_message_id: replyTo,
                },
            },
        });
    } catch (err) {
        if (isDuplicateKeyError(err)) {
            return;
        }
        ctx.log(`whatsapp emit failed (msg ${messageId}): ${formatError(err)}`);
    }
}

/**
 * Pull human-readable text out of a WhatsApp message. Handles the two
 * common shapes (`conversation` for plain text, `extendedTextMessage`
 * for replies / quoted text / formatted text). Returns `null` for
 * everything else so non-text content is dropped cleanly upstream.
 *
 * Image captions and other media payloads are intentionally excluded
 * from v1 — handling them properly involves media downloads and a
 * deferred design decision on what `payload.text` should contain.
 */
function extractMessageText(msg: WAMessage): string | null {
    const m = msg.message;
    if (!m) {
        return null;
    }
    if (typeof m.conversation === "string" && m.conversation.length > 0) {
        return m.conversation;
    }
    const extended = m.extendedTextMessage?.text;
    if (typeof extended === "string" && extended.length > 0) {
        return extended;
    }
    return null;
}

/**
 * Best-effort group-name lookup with an in-memory cache. The cache
 * lives for the lifetime of the socket, so a group rename takes
 * effect after the next reconnect — acceptable for what is essentially
 * a display-only field. A `null` cache entry means lookup failed once
 * and we don't want to keep retrying on every message.
 */
async function resolveGroupName(
    sock: WASocket,
    cache: Map<string, string | null>,
    jid: string,
    ctx: HostContext,
): Promise<string | null> {
    const cached = cache.get(jid);
    if (cached !== undefined) {
        return cached;
    }
    let metadata: GroupMetadata | undefined;
    try {
        metadata = await sock.groupMetadata(jid);
    } catch (err) {
        ctx.log(`whatsapp groupMetadata(${jid}) failed: ${formatError(err)}`);
    }
    const name = metadata?.subject ?? null;
    cache.set(jid, name);
    return name;
}

/**
 * Parse `WHATSAPP_GROUP_ALLOWLIST` (comma-separated). Empty / unset
 * returns `null` meaning "all groups allowed". Each entry is matched
 * against the message's `remoteJid` via `endsWith` so users can write
 * either the full JID (`12345-67890@g.us`) or just the numeric id.
 */
function parseGroupAllowlist(raw: string | undefined): readonly string[] | null {
    if (!raw) {
        return null;
    }
    const entries = raw
        .split(",")
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

/**
 * `messageTimestamp` can be a `Long` (protobuf int64), a number, or
 * absent. Normalize to a JS `number` of unix seconds, defaulting to
 * `Date.now()` so the field is never undefined downstream.
 */
function normalizeTimestamp(raw: WAMessage["messageTimestamp"]): number {
    if (typeof raw === "number") {
        return raw;
    }
    if (raw && typeof raw === "object" && "toNumber" in raw && typeof raw.toNumber === "function") {
        return raw.toNumber();
    }
    return Math.floor(Date.now() / 1000);
}

/**
 * Pull the HTTP-style status code out of whatever baileys handed us.
 * The closed-connection error is a `Boom` whose `output.statusCode`
 * matches a {@link DisconnectReason}. Returns `undefined` when the
 * shape doesn't match (network error, non-Boom throwable, etc.).
 */
function extractStatusCode(err: unknown): number | undefined {
    if (err instanceof Boom) {
        return err.output?.statusCode;
    }
    return undefined;
}

/**
 * Detect the postgres unique-constraint violation that fires when the
 * same idempotency key is inserted twice. Treated as a silent no-op so
 * baileys' occasional duplicate deliveries don't pollute the log.
 */
function isDuplicateKeyError(err: unknown): boolean {
    if (err instanceof Error) {
        const code = (err as { code?: string }).code;
        if (code === "23505") {
            return true;
        }
        return err.message.includes("idempotency_key");
    }
    return false;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Render an unknown thrown value as a short diagnostic string. Mirrors
 * the helper in {@link ../../telegram/src/TelegramDaemon.ts} so log
 * lines from both plugins read consistently.
 */
function formatError(err: unknown): string {
    if (err instanceof Boom) {
        return `Boom ${err.output?.statusCode ?? "?"}: ${err.message}`;
    }
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}
