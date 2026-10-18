import path from "node:path";
import { definePlugin } from "@getfamiliar/shared";
import { readAuthorizedNumber, WHATSAPP_AGENT_TOPIC } from "./AgentAccount.js";
import { buildCommands } from "./Commands.js";
import { createSocketRegistry } from "./Connection.js";
import { WHATSAPP_DIRECT_TOPIC, WHATSAPP_GROUP_TOPIC } from "./UserAccount.js";
import {
    startWhatsAppDaemon,
    stopWhatsAppDaemon,
    type WhatsAppSocketRegistries,
} from "./WhatsAppDaemon.js";
import { buildWhatsAppTools } from "./WhatsAppTools.js";

/**
 * WhatsApp host-side plugin. Pairs up to two WhatsApp accounts as
 * linked devices (the same way WhatsApp Web works):
 *
 * - **user account** (`familiar whatsapp link`) — the user's personal
 *   number, observed passively. Every incoming or self-sent group text
 *   becomes a `chat:whatsapp:group` event, every direct text a
 *   `chat:whatsapp:new` event. The assistant never sends messages in
 *   the user's name; the one server-side write is marking handled
 *   messages as read (`whatsapp_mark_read`), which produces nothing
 *   visible to other people.
 * - **agent account** (`familiar whatsapp link-agent`) — a second
 *   number owned exclusively by the assistant. The user chats with it
 *   like with the Telegram bot: messages from
 *   `whatsapp.agent.authorizedNumber` become `chat:whatsapp` chat
 *   events, and replies on the `whatsapp` chat channel are sent back.
 *
 * Credentials live under `<dataDir>/whatsapp/auth/` (user) and
 * `<dataDir>/whatsapp/agent-auth/` (agent); their presence is what
 * enables each account — there is no parallel `*_ENABLED` flag.
 */
const socketRegistries: WhatsAppSocketRegistries = {
    user: createSocketRegistry(),
    agent: createSocketRegistry(),
};

export default definePlugin({
    id: "whatsapp",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    host: {
        start: (ctx) => startWhatsAppDaemon(ctx, socketRegistries),
        stop: () => stopWhatsAppDaemon(),
        tools: () => buildWhatsAppTools(socketRegistries.user),
        getEmittedEvents: (ctx) => [
            {
                topic: WHATSAPP_GROUP_TOPIC,
                description: "A text message arrived in a WhatsApp group of the linked account.",
                isExactTopic: true,
            },
            {
                topic: WHATSAPP_DIRECT_TOPIC,
                description:
                    "A direct WhatsApp text message was received or sent by the linked account.",
                isExactTopic: true,
            },
            ...(readAuthorizedNumber(ctx) === null
                ? []
                : [
                      {
                          topic: WHATSAPP_AGENT_TOPIC,
                          description: "The user sent a message to the agent's WhatsApp number.",
                      },
                  ]),
        ],
        commands: (ctx) => buildCommands(ctx),
    },
});
