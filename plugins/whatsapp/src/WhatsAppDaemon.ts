import { Boom } from "@hapi/boom";
import makeWASocket, {
    DisconnectReason,
    fetchLatestWaWebVersion,
    type GroupMetadata,
    type WAMessage,
    type WASocket,
} from "@whiskeysockets/baileys";
import type { HostContext } from "@getfamiliar/shared";
import { clearAuth, loadAuth, type WhatsAppAuth } from "./Auth.js";

const TOPIC = "chat:whatsapp:group";
const GROUP_JID_SUFFIX = "@g.us";
const RECONNECT_BACKOFF_MIN_MS = 1000;
const RECONNECT_BACKOFF_MAX_MS = 5 * 60 * 1000;
/**
 * `userAgent` advertised to the WhatsApp servers when this device
 * registers. Showing up in the user's "Linked devices" UI as
 * "familiar" makes the link easy to recognize and revoke.
 */
const BROWSER_DESCRIPTION: [string, string, string] = ["familiar", "Chrome", "1.0"];

/**
 * Build the {@link ILogger} we hand to baileys' `makeWASocket`. By
 * default baileys instantiates its own pino at info level and writes
 * raw JSON straight to stdout, which bypasses the host's pino-pretty
 * pipeline and pollutes the operator's terminal with noise like the
 * helloMsg / connection.update payloads on every reconnect. Routing
 * baileys' output through `ctx.log` instead unifies it with every
 * other plugin line and lets the host's logger own formatting,
 * destinations, and rotation. We only forward warn+error — info /
 * debug / trace are dropped because they're chatty and rarely
 * actionable.
 */
export function buildBaileysLogger(ctx: HostContext): BaileysLogger {
    const log = (level: "warn" | "error", obj: unknown, msg?: string): void => {
        const detail = msg ?? renderLogObject(obj);
        ctx.log(`whatsapp baileys ${level}: ${detail}`);
    };
    const logger: BaileysLogger = {
        level: "warn",
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: (obj, msg) => log("warn", obj, msg),
        error: (obj, msg) => log("error", obj, msg),
        child: () => logger,
    };
    return logger;
}

/**
 * Shape of the `logger` baileys' `makeWASocket` accepts. Inlined here
 * (rather than imported from baileys) because the public type alias
 * lives behind an internal path that's awkward to import; the surface
 * is small and stable.
 */
interface BaileysLogger {
    level: string;
    child(obj: Record<string, unknown>): BaileysLogger;
    trace(obj: unknown, msg?: string): void;
    debug(obj: unknown, msg?: string): void;
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
    error(obj: unknown, msg?: string): void;
}

/**
 * Best-effort stringifier for whatever baileys hands the logger as
 * the first arg (pino convention: structured object first, message
 * second). Skips circular structures so a logging call can never
 * crash the daemon.
 */
function renderLogObject(obj: unknown): string {
    if (typeof obj === "string") {
        return obj;
    }
    try {
        return JSON.stringify(obj);
    } catch {
        return "[unserializable]";
    }
}

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
    // `creds.json` exists but `me` is only populated after a *complete*
    // two-phase pair (QR scan + server-confirmed reconnect). Half-baked
    // creds — e.g. left over from a link command that exited on the
    // first 515 — would otherwise silently fall through to baileys'
    // "register a new device" path, which loops on QR timeouts forever
    // because no one is watching the daemon log to scan it.
    if (!auth.state.creds.me?.id) {
        ctx.log(
            "whatsapp creds on disk are incomplete (no `me`); run `./cli.sh whatsapp logout` and re-link",
        );
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
    const allowlist = parseGroupAllowlist(ctx.config.getArray("whatsapp.groupAllowlist", null));
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
    const version = await resolveWaVersion(ctx);
    const sock = makeWASocket({
        auth: auth.state,
        printQRInTerminal: false,
        browser: BROWSER_DESCRIPTION,
        version,
        logger: buildBaileysLogger(ctx),
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
    const groupCode = buildGroupCode(groupName);
    const senderJid = msg.key.fromMe
        ? (sock.user?.id ?? null)
        : (msg.key.participant ?? msg.participant ?? null);
    const timestamp = normalizeTimestamp(msg.messageTimestamp);
    const replyTo = msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null;
    const senderLabel = msg.pushName ?? senderJid ?? "an unknown sender";
    const groupLabel = groupName ?? remoteJid;
    const prompt = msg.key.fromMe
        ? `Our owner sent a message in WhatsApp group "${groupLabel}": ${text}`
        : `A new WhatsApp group message from somebody else: ${senderLabel} in "${groupLabel}" arrived: ${text}`;

    try {
        await ctx.events.emit({
            topic: TOPIC,
            isChat: false,
            idempotencyKey: `whatsapp:${messageId}`,
            prompt,
            payload: {
                text,
                whatsapp: {
                    message_id: messageId,
                    group_jid: remoteJid,
                    group_name: groupName,
                    group_code: groupCode,
                    from: {
                        jid: senderJid,
                        name: msg.pushName ?? null,
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
 * Fetch the current WhatsApp Web protocol version baileys should
 * advertise to the server. Pinning to a stale version causes the
 * server to reject the handshake with `statusCode=405`, which is the
 * symptom we see when the bundled `Defaults` version drifts behind
 * what WhatsApp's servers currently require.
 *
 * Falls back to `undefined` (= use baileys' bundled default) on
 * lookup failure — better to attempt the connection with the stale
 * version than to refuse to start at all when WhatsApp's version
 * endpoint is unreachable.
 */
export async function resolveWaVersion(
    ctx: HostContext,
): Promise<[number, number, number] | undefined> {
    try {
        const result = await fetchLatestWaWebVersion({});
        return result.version;
    } catch (err) {
        ctx.log(
            `whatsapp version lookup failed, falling back to bundled default: ${formatError(err)}`,
        );
        return undefined;
    }
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
