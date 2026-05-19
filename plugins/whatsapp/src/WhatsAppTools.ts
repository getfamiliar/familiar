import type { EventRow, PluginTool } from "@getfamiliar/shared";
import type { WAMessageKey } from "@whiskeysockets/baileys";
import type { WhatsAppSocketRegistry } from "./WhatsAppDaemon.js";

/**
 * Structured failure envelope returned to the agent when a tool body
 * throws. Mirrors the shape used by the mail plugin's tools so the
 * agent's response parsing stays uniform across plugins: every tool
 * resolves with either `{ ok: true, ... }` or `{ ok: false, error: {
 * code, message } }`.
 */
interface ToolFailure {
    readonly ok: false;
    readonly error: {
        readonly code: string;
        readonly message: string;
    };
}

/**
 * Wrap a tool body so its return value is augmented with `ok: true` and
 * any thrown error becomes a `ToolFailure`. Keeps the success/failure
 * shape consistent without each tool repeating the try/catch.
 */
async function runTool<TResult extends object>(
    body: () => Promise<TResult>,
): Promise<({ ok: true } & TResult) | ToolFailure> {
    try {
        const result = await body();
        return { ok: true, ...result };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code: "ToolError", message } };
    }
}

/**
 * Build the WhatsApp plugin's agent-facing tools. The {@link
 * WhatsAppSocketRegistry} is captured by closure; each tool reads the
 * currently-connected socket at call time so a reconnect mid-session
 * doesn't leave the tool holding a stale reference.
 *
 * Today the plugin contributes one tool: `mark_read`, registered as
 * `whatsapp_mark_read` after the plugin-id namespacing applied by the
 * host's tool gateway.
 */
export function buildWhatsAppTools(registry: WhatsAppSocketRegistry): readonly PluginTool[] {
    return [markReadTool(registry)];
}

/**
 * Tool that marks the WhatsApp group message this agentrun is reacting
 * to as read on the user's phone. Resolves the {@link WAMessageKey}
 * from `event.payload.whatsapp` (the same fields the daemon stamped on
 * the event at emit time) and calls baileys' bulk `readMessages`.
 *
 * Takes no arguments — handlers can only ever mark the message of the
 * current event, never an arbitrary historical message. Returns
 * `{ ok: true, marked: true }` on success or a `ToolFailure` on a
 * disconnected socket, malformed payload, or baileys error.
 */
function markReadTool(
    registry: WhatsAppSocketRegistry,
): PluginTool<Record<string, never>, { ok: true; marked: true } | ToolFailure> {
    return {
        name: "mark_read",
        description:
            "Mark the WhatsApp group message this agentrun is reacting to as read on " +
            "the user's phone. Call this once you've handled the message (e.g. after " +
            "appending it to a digest file) so it stops appearing as unread in " +
            "WhatsApp. No arguments — the message is taken from the current event.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        execute: (_args, callCtx) =>
            runTool(async () => {
                const key = resolveMessageKey(callCtx.event);
                const sock = registry.current();
                if (sock === null) {
                    throw new Error(
                        "whatsapp socket is not connected; cannot mark message as read",
                    );
                }
                await sock.readMessages([key]);
                return { marked: true as const };
            }),
    };
}

/**
 * Pull the {@link WAMessageKey} fields out of the event payload the
 * WhatsApp daemon emits. Throws a descriptive error if the payload is
 * not a WhatsApp event — the agent should only ever invoke this tool
 * from a `chat:whatsapp:group` agentrun, so a missing field indicates a
 * real misuse rather than something to recover from silently.
 */
function resolveMessageKey(event: EventRow): WAMessageKey {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") {
        throw new Error(
            "event.payload is missing — mark_read requires a chat:whatsapp:group event",
        );
    }
    const wa = (payload as { whatsapp?: unknown }).whatsapp;
    if (wa === null || typeof wa !== "object") {
        throw new Error("event.payload.whatsapp is missing");
    }
    const id = readPayloadString(wa as object, "message_id");
    const remoteJid = readPayloadString(wa as object, "group_jid");
    const from = (wa as { from?: unknown }).from;
    if (from === null || typeof from !== "object") {
        throw new Error("event.payload.whatsapp.from is missing");
    }
    const participantRaw = (from as { jid?: unknown }).jid;
    const participant =
        typeof participantRaw === "string" && participantRaw.length > 0
            ? participantRaw
            : undefined;
    const fromMe = (from as { is_self?: unknown }).is_self === true;
    return {
        id,
        remoteJid,
        ...(participant !== undefined ? { participant } : {}),
        ...(fromMe ? { fromMe: true } : {}),
    };
}

function readPayloadString(obj: object, key: string): string {
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`event.payload.whatsapp.${key} is missing or not a string`);
    }
    return value;
}
