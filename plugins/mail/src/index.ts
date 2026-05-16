import { definePlugin } from "effective-assistant-shared";
import { buildCommands, buildMain } from "./Commands.js";
import { startMailDaemon } from "./MailDaemon.js";
import { buildMailTools } from "./providers/o365/MailTools.js";
import { o365Provider } from "./providers/Registry.js";

/**
 * Mail host-side plugin.
 *
 * Polls one or more mailboxes and emits a `mail:<provider>` event per
 * new mail. Day-1 provider is Microsoft 365 via direct Microsoft Graph
 * calls (no MCP — see [[project_ms365_mcp_incompatible]] for the
 * rationale and [[feedback_top_level_subprojects]] for the role-based
 * "Graph client" naming). The plugin is structured so a second
 * provider (Gmail, IMAP, …) lands as a sibling implementation under
 * `src/providers/<id>/` with no edits to the orchestration core.
 *
 * Authentication is host-side via msal-node device-code flow; the
 * agent container never sees tokens. Tools the agent calls
 * (`fetch_body`, `draft_reply`, `send_new`, etc.) run in the host
 * process with access to the plugin's GraphClient.
 *
 * The plugin runs on operational defaults — no `mail:` block in
 * `config.yml` is required. Real enablement is gated on at least one
 * o365 login being cached in `data/mail/o365/`; run
 * `./cli.sh mail o365 login` to add one.
 */
export default definePlugin({
    id: "mail",
    host: {
        start: (ctx) => startMailDaemon(ctx),
        tools: () => buildMailTools(o365Provider),
        commands: (ctx) => buildCommands(ctx),
        main: () => buildMain(),
    },
});
