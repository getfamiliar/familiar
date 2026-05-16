import path from "node:path";
import { definePlugin } from "@getfamiliar/shared";
import { buildCommands } from "./Commands.js";
import { startWhatsAppDaemon } from "./WhatsAppDaemon.js";

/**
 * WhatsApp host-side plugin.
 *
 * Read-only group observer that pairs the user's personal WhatsApp
 * account as a linked device (the same way WhatsApp Web works) and
 * emits one `chat:whatsapp:group` event per incoming group message.
 *
 * Deliberately one-directional: the assistant never replies on
 * WhatsApp. A reply path would need a separate phone number for the
 * assistant, and the resulting "chat with yourself to chat with the
 * assistant" UX is awkward — better to use Telegram for chat. The
 * goal here is *passive observation* so workflows can summarize
 * group activity without the user having to scroll.
 *
 * Pairing is gated by an explicit `./cli.sh whatsapp link` step. The
 * presence of credentials on disk under `<dataDir>/whatsapp/auth/`
 * is what enables the daemon — there is no parallel `*_ENABLED` env
 * flag.
 */
export default definePlugin({
    id: "whatsapp",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    host: {
        start: (ctx) => startWhatsAppDaemon(ctx),
        commands: (ctx) => buildCommands(ctx),
    },
});
