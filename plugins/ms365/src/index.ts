import path from "node:path";
import { definePlugin } from "@getfamiliar/shared";
import { buildMs365Commands } from "./Commands.js";
import { startMs365Daemon } from "./Ms365Daemon.js";
import { buildSentSampleTool } from "./mail/SentSampleTool.js";

/**
 * Microsoft 365 host-side plugin.
 *
 * Polls one or more Microsoft 365 mailboxes via Microsoft Graph and
 * emits a `mail:ms365` event per new message. Calendar support shares
 * the same auth and Graph client.
 *
 * Authentication is host-side via msal-node device-code flow; the
 * agent container never sees tokens. Both mail and calendar surfaces
 * are reached through the core `mail_*` / `cal_*` tools, which
 * dispatch to the provider this plugin registers in
 * {@link startMs365Daemon} via `ctx.mail.registerProvider` and
 * `ctx.calendar.registerProvider`.
 *
 * The plugin runs on operational defaults — no `ms365:` block in
 * `config.yml` is required. Real enablement is gated on at least one
 * login being cached in `data/ms365/auth/`; run `./cli.sh ms365 login`
 * to add one.
 */
export default definePlugin({
    id: "ms365",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    host: {
        start: (ctx) => startMs365Daemon(ctx),
        commands: (ctx) => buildMs365Commands(ctx),
        tools: () => [buildSentSampleTool()],
    },
});
