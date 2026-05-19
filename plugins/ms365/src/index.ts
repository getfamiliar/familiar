import { definePlugin } from "@getfamiliar/shared";
import { buildMs365Commands } from "./Commands.js";
import { startMs365Daemon } from "./Ms365Daemon.js";
import { buildMailTools } from "./mail/MailTools.js";

/**
 * Microsoft 365 host-side plugin.
 *
 * Polls one or more Microsoft 365 mailboxes via Microsoft Graph and
 * emits a `mail:ms365` event per new message. Calendar support lands
 * in this same plugin next, reusing the auth and Graph client.
 *
 * Authentication is host-side via msal-node device-code flow; the
 * agent container never sees tokens. Tools the agent calls
 * (`fetch_body`, `draft_reply`, `send_new`, etc., registered under
 * the `ms365_` prefix) run in the host process with access to the
 * plugin's `LoginStore`.
 *
 * The plugin runs on operational defaults — no `ms365:` block in
 * `config.yml` is required. Real enablement is gated on at least one
 * login being cached in `data/ms365/auth/`; run `./cli.sh ms365 login`
 * to add one.
 */
export default definePlugin({
    id: "ms365",
    host: {
        start: (ctx) => startMs365Daemon(ctx),
        tools: () => buildMailTools(),
        commands: (ctx) => buildMs365Commands(ctx),
    },
});
