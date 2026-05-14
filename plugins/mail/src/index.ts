import { definePlugin } from "effective-assistant-shared";
import { buildCommands, buildMain } from "./Commands.js";
import { startMailDaemon } from "./MailDaemon.js";

/**
 * Mail host-side plugin.
 *
 * Polls one or more mail MCPs and emits a `mail:<provider>` event
 * per new mail. Day-1 provider is Microsoft 365 via
 * `@softeria/ms-365-mcp-server`; the plugin is structured so a
 * second provider (Gmail, Proton, IMAP, …) lands as a sibling
 * implementation under `src/providers/<id>/` with no edits to the
 * orchestration core.
 *
 * Polling is single-direction (read inbox, emit events). Sending,
 * marking-read, and the like belong in handler tools rather than
 * here — this plugin's job is to surface the event, the handler's
 * job is to react.
 *
 * The plugin runs on defaults — no `mail:` block in `config.yml` is
 * required. Real enablement is gated on each provider's MCP being
 * declared in `mcp.yml` and the user being logged in.
 */
export default definePlugin({
    id: "mail",
    host: {
        start: (ctx) => startMailDaemon(ctx),
        commands: (ctx) => buildCommands(ctx),
        main: () => buildMain(),
    },
});
