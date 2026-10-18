import type { HostContext } from "@getfamiliar/shared";
import { Boom } from "@hapi/boom";
import makeWASocket, {
    DisconnectReason,
    fetchLatestWaWebVersion,
    type WAMessage,
    type WASocket,
} from "@whiskeysockets/baileys";
import { clearAuth, linkSubcommandFor, type WhatsAppAuth } from "./Auth.js";

const RECONNECT_BACKOFF_MIN_MS = 1000;
const RECONNECT_BACKOFF_MAX_MS = 5 * 60 * 1000;

/**
 * `userAgent` advertised to the WhatsApp servers when this device
 * registers. Showing up in the user's "Linked devices" UI as
 * "familiar" makes the link easy to recognize and revoke.
 */
export const BROWSER_DESCRIPTION: [string, string, string] = ["familiar", "Chrome", "1.0"];

/**
 * Read-only handle on the live baileys socket of one account. Tools
 * and chat subscribers that need to call server-side WhatsApp
 * operations reach the socket through this — the connection loop owns
 * the socket's lifecycle and publishes the current one here.
 * `current()` returns `null` while reconnecting or before pairing, so
 * callers must tolerate a missing socket and surface a sensible error
 * instead of crashing.
 */
export interface WhatsAppSocketRegistry {
    /** Currently connected socket, or `null` when offline / reconnecting. */
    current(): WASocket | null;
}

/**
 * Daemon-side view of the registry: in addition to reading, the
 * connection loop updates the current socket on every connect /
 * disconnect.
 */
export interface MutableSocketRegistry extends WhatsAppSocketRegistry {
    set(sock: WASocket | null): void;
}

/**
 * Build a fresh socket registry. The plugin manifest constructs one per
 * account at module load and shares it between the connection loop
 * (which mutates it) and the tools / chat subscribers (which only
 * read). Keeping the registry minimal — no events, no history — means
 * readers never accidentally hold a stale socket past a reconnect.
 *
 * @returns An empty registry.
 */
export function createSocketRegistry(): MutableSocketRegistry {
    let sock: WASocket | null = null;
    return {
        current: () => sock,
        set: (next) => {
            sock = next;
        },
    };
}

/**
 * Build the {@link BaileysLogger} we hand to baileys' `makeWASocket`. By
 * default baileys instantiates its own pino at info level and writes
 * raw JSON straight to stdout, which bypasses the host's pino-pretty
 * pipeline and pollutes the operator's terminal with noise like the
 * helloMsg / connection.update payloads on every reconnect. Routing
 * baileys' output through `ctx.log` instead unifies it with every
 * other plugin line and lets the host's logger own formatting,
 * destinations, and rotation. We only forward warn+error — info /
 * debug / trace are dropped because they're chatty and rarely
 * actionable.
 *
 * @param ctx Host context whose logger receives the output.
 * @returns A baileys-compatible logger.
 */
export function buildBaileysLogger(ctx: HostContext): BaileysLogger {
    const log = (level: "warn" | "error", obj: unknown, msg?: string): void => {
        const detail = msg ?? renderLogObject(obj);
        ctx.logger.info(`whatsapp baileys ${level}: ${detail}`);
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
 * Account-specific wiring applied to every fresh socket, e.g. the
 * `messages.upsert` handler. Called once per connection attempt, right
 * after the socket is created.
 */
export type SocketAttacher = (sock: WASocket) => void;

/**
 * Forever-loop that owns one baileys socket of one account at a time.
 * Reconnects with exponential backoff on any close other than
 * `loggedOut`. On `loggedOut`, wipes that account's auth and exits the
 * loop — the user must re-link the device before another connection
 * makes sense.
 *
 * @param ctx Host context for logging and auth wiping.
 * @param auth Loaded, complete auth state of the account.
 * @param registry Registry the current socket is published to.
 * @param attach Account-specific handlers wired onto each socket.
 */
export async function runConnectionLoop(
    ctx: HostContext,
    auth: WhatsAppAuth,
    registry: MutableSocketRegistry,
    attach: SocketAttacher,
): Promise<void> {
    const label = `whatsapp[${auth.account}]`;
    const linkCommand = `familiar whatsapp ${linkSubcommandFor(auth.account)}`;
    let backoffMs = RECONNECT_BACKOFF_MIN_MS;
    while (true) {
        const reason = await runConnection(ctx, auth, registry, attach, label);
        if (reason === "loggedOut") {
            ctx.logger.info(
                `${label} logged out (device removed from phone); clearing auth and stopping. Run \`${linkCommand}\` to re-pair.`,
            );
            await clearAuth(ctx, auth.account);
            return;
        }
        ctx.logger.info(`${label} disconnected (${reason}); reconnecting in ${backoffMs}ms`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
    }
}

/**
 * Run a single baileys session: build the socket, attach handlers,
 * and resolve when the connection closes. The resolved value is
 * either `"loggedOut"` (terminal — caller must wipe auth) or any
 * other string description suitable for log output.
 */
async function runConnection(
    ctx: HostContext,
    auth: WhatsAppAuth,
    registry: MutableSocketRegistry,
    attach: SocketAttacher,
    label: string,
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
    registry.set(sock);
    attach(sock);

    return await new Promise<"loggedOut" | string>((resolve) => {
        sock.ev.on("connection.update", (update) => {
            if (update.connection === "open") {
                const me = sock.user?.id ?? "unknown";
                ctx.logger.info(`${label} online as ${me}`);
                return;
            }
            if (update.connection === "close") {
                registry.set(null);
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
 * Pull human-readable text out of a WhatsApp message. Handles the two
 * common shapes (`conversation` for plain text, `extendedTextMessage`
 * for replies / quoted text / formatted text). Returns `null` for
 * everything else so non-text content is dropped cleanly upstream.
 *
 * Image captions and other media payloads are intentionally excluded
 * — handling them properly involves media downloads and a deferred
 * design decision on what `payload.text` should contain.
 *
 * @param msg The incoming message.
 * @returns The text, or `null` for non-text content.
 */
export function extractMessageText(msg: WAMessage): string | null {
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
 * `messageTimestamp` can be a `Long` (protobuf int64), a number, or
 * absent. Normalize to a JS `number` of unix seconds, defaulting to
 * `Date.now()` so the field is never undefined downstream.
 *
 * @param raw The raw protobuf timestamp.
 * @returns Unix seconds.
 */
export function normalizeTimestamp(raw: WAMessage["messageTimestamp"]): number {
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
 * Resolve after `ms` milliseconds.
 *
 * @param ms Delay in milliseconds.
 */
export function sleep(ms: number): Promise<void> {
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
 *
 * @param ctx Host context for logging.
 * @returns The version triple, or `undefined` on lookup failure.
 */
export async function resolveWaVersion(
    ctx: HostContext,
): Promise<[number, number, number] | undefined> {
    try {
        const result = await fetchLatestWaWebVersion({});
        return result.version;
    } catch (err) {
        ctx.logger.info(
            `whatsapp version lookup failed, falling back to bundled default: ${formatError(err)}`,
        );
        return undefined;
    }
}

/**
 * Render an unknown thrown value as a short diagnostic string. Mirrors
 * the helper in {@link ../../telegram/src/TelegramDaemon.ts} so log
 * lines from both plugins read consistently.
 *
 * @param err Any thrown value.
 * @returns A one-line description.
 */
export function formatError(err: unknown): string {
    if (err instanceof Boom) {
        return `Boom ${err.output?.statusCode ?? "?"}: ${err.message}`;
    }
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}
