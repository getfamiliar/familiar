import path from "node:path";
import { definePlugin } from "@getfamiliar/shared";
import { buildCommands } from "./Commands.js";
import { createSocketRegistry, startWhatsAppDaemon } from "./WhatsAppDaemon.js";
import { buildWhatsAppTools } from "./WhatsAppTools.js";

/**
 * WhatsApp host-side plugin.
 *
 * Read-only group observer that pairs the user's personal WhatsApp
 * account as a linked device (the same way WhatsApp Web works) and
 * emits one `chat:whatsapp:group` event per incoming group message.
 *
 * Deliberately one-directional for outbound chat: the assistant never
 * sends new WhatsApp messages. A reply path would need a separate phone
 * number for the assistant, and the resulting "chat with yourself to
 * chat with the assistant" UX is awkward — better to use Telegram for
 * chat. The goal here is *passive observation* so workflows can
 * summarize group activity without the user having to scroll. The one
 * server-side write the plugin does perform is marking digested
 * messages as read (`whatsapp_mark_read`), which mutates per-user state
 * without producing any visible message in the group.
 *
 * Pairing is gated by an explicit `./cli.sh whatsapp link` step. The
 * presence of credentials on disk under `<dataDir>/whatsapp/auth/`
 * is what enables the daemon — there is no parallel `*_ENABLED` env
 * flag.
 */
const socketRegistry = createSocketRegistry();

export default definePlugin({
    id: "whatsapp",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    host: {
        start: (ctx) => startWhatsAppDaemon(ctx, socketRegistry),
        tools: () => buildWhatsAppTools(socketRegistry),
        commands: (ctx) => buildCommands(ctx),
    },
});
