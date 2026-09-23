import path from "node:path";
import { definePlugin } from "@getfamiliar/shared";
import { buildTeslaCommands } from "./Commands.js";
import { startTeslaDaemon } from "./TeslaDaemon.js";
import { buildTeslaTools } from "./tools/index.js";

/**
 * Tesla host-side plugin.
 *
 * Read-only access to the user's car through the unofficial Owner API:
 * vehicle list, full state, position, and the Supercharger / Premium
 * Connectivity invoice PDFs the monthly bookkeeping needs.
 *
 * Authentication is host-side (`data/tesla/auth.json`); the agent
 * container never sees a token. The plugin emits no events and runs no
 * pollers — every capability is a tool the agent calls on demand.
 *
 * Remote commands are intentionally not implemented; see the README
 * for why (vehicles have required signed commands since 2024).
 */
export default definePlugin({
    id: "tesla",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    host: {
        start: (ctx) => startTeslaDaemon(ctx),
        commands: (ctx) => buildTeslaCommands(ctx),
        tools: () => buildTeslaTools(),
    },
});
