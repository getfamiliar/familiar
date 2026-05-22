# Microsoft 365 plugin

Polls one or more Microsoft 365 mailboxes and calendars via direct Microsoft
Graph calls (no MCP — see `memory/project_ms365_mcp_incompatible.md` for the
rationale). Mail polling emits a `mail:ms365` event per new mail; calendar
polling feeds the core `calendar_events` table the plugin-agnostic `cal_*`
agent tools read from, and emits a `calendar:new` event when an event the
poller hasn't seen before shows up.

**Calendar scope**: the plugin supports the user's own calendars and shared
calendars they have delegated access to. Group calendars and team / Microsoft
365 Group calendars are **not supported** (a different Graph surface).

The plugin runs on operational defaults — no `ms365:` block in `config.yml` is
required. Real enablement is gated on at least one cached login under
`data/ms365/auth/`; run `./cli.sh ms365 login` to add one.

## What the agent sees

For every new mail the plugin emits a `mail:ms365` event. The container's
handler resolver picks up the most specific handler available —
`workspace/mail/ms365/index.md` first, falling back to
`workspace/mail/index.md`. The handler decides what to do; the plugin's job
is only to surface the mail.

**Prompt** the handler receives:

> A new e-mail was received from `<from-display>` with subject `"<subject>"`,
> see payload for metadata. The body starts with: `<bodyPreview>`

When the body preview is at Graph's truncation cap (255 chars), the prompt
ends with:

> Body is truncated. Use the mail_fetch_body tool to get the full body.

**Payload**:

```ts
{
    mail_id: string,        // "<plugin>:<mailbox>:<realId>" — pass to every core mail_* tool
    isShared: boolean,
    from: { name: string | null; address: string; rawAddress: string | null },
    to:    Array<{ name: string | null; address: string; rawAddress: string | null }>,
    cc:    Array<{ name: string | null; address: string; rawAddress: string | null }>,
    subject: string,
    date: string,           // ISO-8601, == receivedDateTime
    internetMessageId: string,
    hasAttachments: boolean,
    attachments: Array<{
        id: string,
        name: string,
        contentType: string,
        size: number,       // bytes
        isInline: boolean,
    }> | null,
}
```

### Tools the agent gets

The plugin contributes no agent tools of its own. Mail surfaces are reached
through the core `mail_*` tools (defined in `host/src/mail/MailTools.ts`),
which dispatch to whichever provider owns the `<pluginId>:` prefix on a given
mail id. This plugin registers a `MailProvider` for the `ms365:` prefix
during `start()`.

The core tools relevant to ms365 mails:

| Tool | Effect |
|------|--------|
| `mail_fetch_body` | Full plain-text body of one mail. |
| `mail_fetch_attachments` | Downloads non-inline attachments into `/scratch/<event-id>/`. |
| `mail_draft_reply` | Reply draft. `replyAll: true` to include every recipient. |
| `mail_draft_new` | Brand-new draft. Takes `from: "<plugin>:<mailbox>"`. |
| `mail_send_reply` | Send a reply. Gated by core `mail.allowSend` + `mail.recipientWhitelist`. |
| `mail_send_new` | Send a brand-new mail. Same gates. |
| `mail_draft_forward` | Forwarding draft. |
| `mail_send_forward` | Forward immediately. Same gates. |
| `mail_move` | Move to `inbox` / `archive` / `trash`. |

Every tool resolves `mail_id` from its argument or — when omitted — from
`event.payload.mail_id` of the triggering mail event. From chat handlers,
pass `mail_id` explicitly.

`send_*` tools fall back to creating a draft (and report why) when
`mail.allowSend` is `false` or a recipient violates the whitelist.

### Attachments

When a message has attachments, the polling loop downloads every non-inline
attachment up-front via the same Graph endpoint the `mail_fetch_attachments`
tool uses. Bytes that fit Graph's inline-bytes ceiling (~3 MB) ship straight
into the event's `/scratch/<event-id>/` directory; metadata lands in
`payload.attachments` either way. The `attachments` field is `null` only when
the polling-time fetch errored — the agent can still call
`mail_fetch_attachments` and retry.

### Address safety

Every address that lands in the payload is run through a strict validator
(`isSafeEmailAddress` in `src/mail/Sanitize.ts`). The `address` field on
`from` / `to` / `cc` and the top-level `upn` / `mailbox` strings are
**always safe to use as filename components** — handlers can do
`workspace/people/<address>.md` without further escaping.

If the upstream value fails validation (path separators, `..`, control
characters, malformed shape, etc.) the field carries the safe sentinel
`invalid@invalid.invalid` and the raw, untrusted bytes are preserved on
`rawAddress`. **Handlers must never use `rawAddress` as a path component.**

Idempotency key: `mail:ms365:<internetMessageId>`. The bus rejects duplicates,
so each mail produces at most one event ever — across re-polls, delta-link
resets, and daemon restarts.

## Setting up

### 1. About the bundled app

The plugin ships with a hard-coded **multi-tenant Public Client** Entra ID app
that the project owns. Tokens are minted against your tenant and stay in
`data/ms365/auth/<upn>.json` on this machine — the app owner has no way to
read your tenant data, because all access goes through Microsoft Graph using a
token only your device has. The token cache file is written with mode `0o600`
and is gitignored.

If you'd rather not trust the bundled app at all, register your own (see
"Bring your own app" below) and set `ms365.clientId` / `ms365.tenantId` in
`config.yml`.

### App scopes

The bundled app asks for the following Microsoft Graph scopes. The plugin
asks for all of them at consent time so one cached login covers every feature
on the roadmap (today + planned). Re-registering an own app means granting the
same set.

| Scope                          | Why the plugin needs it                                                                |
|--------------------------------|----------------------------------------------------------------------------------------|
| `email`                        | OpenID-Connect sign-in scope; gives the plugin the user's primary email address.       |
| `User.Read`                    | OpenID-Connect sign-in scope; reads the signed-in user's profile (UPN, display name).  |
| `offline_access`               | Mints the refresh token msal-node caches under `data/ms365/auth/<upn>.json`.           |
| `Mail.Read`                    | Read messages in the signed-in user's mailbox during inbox polling.                    |
| `Mail.Read.Shared`             | Same, for shared mailboxes the user has delegated read access to.                      |
| `Mail.ReadWrite`               | Move messages between folders, create drafts in the signed-in user's mailbox.          |
| `Mail.ReadWrite.Shared`        | Same, for shared mailboxes.                                                            |
| `Mail.Send`                    | Send replies / new mail from the signed-in user's mailbox.                             |
| `Mail.Send.Shared`             | Same, on behalf of a shared mailbox.                                                   |
| `MailboxFolder.Read`           | Resolve the well-known folder ids (`inbox`, `archive`, `deleteditems`) used by `mail_move`. |
| `MailboxSettings.ReadWrite`    | Reserved for an upcoming out-of-office automation that reads and updates auto-reply settings. |
| `Calendars.ReadWrite`          | Read events from the user's own calendars during delta polling; create new events via `cal_create_event`. |
| `Calendars.ReadWrite.Shared`   | Same, for calendars shared with the user (delegated access).                          |
| `OnlineMeetings.ReadWrite`     | Populate `onlineMeeting.joinUrl` on Teams meetings created via `cal_create_event` with `is_videocall: true`. |

### 2. Log in

```bash
./cli.sh ms365 login
```

The CLI prints a Microsoft device-code URL and a short code; visit the URL on
any browser-equipped device, paste the code, sign in, and grant consent. The
plugin writes the token cache to `data/ms365/auth/<your-upn>.json` and the
daemon picks it up on the next start.

Repeat the command to add additional accounts — every login lands in its own
cache file and is polled separately.

### 3. Verify

```bash
./cli.sh ms365 status
```

Lists every cached login, marks each as `✓` or `✗`, lists configured
mailboxes, and shows the current `allowSend` setting. No daemon required.

### 4. Train your mail style

The plugin sends outbound mail through the core mail-style template at
`data/mail/templates/<mailbox>/default.json`. Until that file exists for a mailbox,
**every mail you send through that mailbox goes out as bare rendered HTML — no font, no
signature**. Recipients see the agent's content in their mail client's default style.

To produce the template, fire the `mail/extract-style` workspace handler from cli-chat
once per mailbox you want styled:

```
./cli.sh chat
> /mail/extract-style Extract for adam@example.com
```

The handler will:

1. Call `ms365_get_sent_sample` to harvest recent reply / forward / new mails from that
   mailbox's Sent Items.
2. Read them and decide your signature, your default text style (CSS), whether you write
   plain text or HTML, and whether you include your signature on replies / forwards.
3. Write the result to `data/mail/templates/<mailbox>/default.json`.

The send path reads that file fresh on every outgoing mail (mtime-cached, no daemon
restart needed), so the next send picks it up immediately. Re-run the slash command any
time your signature or font preference changes; it's idempotent and overwrites.

If the prompt to the handler doesn't name a mailbox, it asks back and stops — so always
include the address. One mailbox per invocation; if you have multiple, fire the command
multiple times.

### 5. (Optional) Configure mailboxes / behavior

```yaml
ms365:
  clientId: ""               # override the bundled multi-tenant app id
  tenantId: common           # override OAuth tenant
  mail:
    mailboxes: []            # empty = every logged-in account's primary inbox
    allowSend: false         # see "Sending" below
    recipientWhitelist: []   # used only when allowSend=true
    pollingInterval: 15      # minutes; default 15
    pollingBackoff: 1        # minutes; base for exponential backoff; default 1
```

The `mailboxes:` whitelist applies across all logged-in accounts. Entries that
match a logged-in account's primary email are polled as that account's own
inbox; entries that don't are tried as shared mailboxes (any logged-in account
with delegated read access wins).

### Sending

`allowSend` defaults to **false** — every `ms365_send_*` call falls back to
creating a draft and the agent gets a clear reason it can pass back to the
user. Set `allowSend: true` once you're confident in the agent's behaviour.

`recipientWhitelist` is a safety net that's only consulted when `allowSend` is
true. Each entry is either a full address (`anna@example.com`) or a domain
anchor (`@example.com` — note the leading `@`). A recipient is allowed if it
matches an entry verbatim or shares a domain with an `@`-anchored entry. An
empty whitelist means "no recipient restriction" once `allowSend` is true.

If any recipient on a `send_reply` / `send_new` call fails the whitelist, the
tool creates a draft instead and reports the violating address — the agent can
escalate to chat for approval.

## Bring your own app (optional)

The bundled multi-tenant app is convenient but the credentials live with the
project. To register your own Entra ID Public Client app:

1. In the Microsoft Entra admin centre: **Identity** → **Applications** →
   **App registrations** → **New registration**.
2. Account type: pick **Multitenant** if you want to support multiple tenants
   from one binary, **Single tenant** if not.
3. **Redirect URI**: skip — device-code flow doesn't use redirects.
4. After registration, open the app and:
   - Note the **Application (client) ID** — this is your `clientId`.
   - For single-tenant: note the **Directory (tenant) ID** as `tenantId`. For
     multi-tenant: keep `tenantId: common`.
   - Under **Authentication** → enable **Allow public client flows: Yes**.
5. Under **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions**, add every scope from the "App scopes" table
   above (`email`, `User.Read`, `offline_access`, `Mail.Read`,
   `Mail.Read.Shared`, `Mail.ReadWrite`, `Mail.ReadWrite.Shared`, `Mail.Send`,
   `Mail.Send.Shared`, `MailboxFolder.Read`, `MailboxSettings.ReadWrite`,
   `Calendars.ReadWrite`, `Calendars.ReadWrite.Shared`,
   `OnlineMeetings.ReadWrite`).
   Click **Grant admin consent** if your tenant requires it.
6. Put the values into `config.yml`:

   ```yaml
   ms365:
     clientId: "your-app-guid"
     tenantId: "common"   # or your tenant guid
   ```

7. Re-run `./cli.sh ms365 login` and consent against your app this time.

## CLI reference

```
./cli.sh ms365                # show help
./cli.sh ms365 status         # logins, mailboxes, send gate
./cli.sh ms365 login          # add a new account via device-code
./cli.sh ms365 logout [upn]   # remove one or all logins
./cli.sh ms365 cal list       # list every calendar each active login can reach
```

All subcommands work without the daemon — they talk to Microsoft Graph
directly using the host-side token cache.

## Config reference

| Key                                   | Default  | Meaning                                                                            |
|---------------------------------------|----------|------------------------------------------------------------------------------------|
| `ms365.clientId`                      | bundled  | Entra ID app id; override to use your own registration.                            |
| `ms365.tenantId`                      | `common` | OAuth authority tenant.                                                            |
| `ms365.mail.enabled`                  | `true`   | Master switch for the mail feature. `false` skips polling and unregisters the `ms365_*` mail tools. |
| `ms365.mail.mailboxes`                | `[]`     | Whitelist; empty = every logged-in account's primary mailbox.                      |
| `ms365.mail.allowSend`                | `false`  | `false` → every `ms365_send_*` becomes a draft.                                    |
| `ms365.mail.recipientWhitelist`       | `[]`     | Allowed addresses or `@domain` anchors when `allowSend=true`.                      |
| `ms365.mail.pollingInterval`          | 15       | Minutes between successful polls.                                                  |
| `ms365.mail.pollingBackoff`           | 1        | Minutes; base of exponential backoff on poll errors. Cap = `pollingInterval × 4`.  |
| `ms365.calendar.enabled`              | `true`   | Master switch for the calendar feature. `false` skips polling and does not register the ms365 calendar provider. |
| `ms365.calendar.calendars`            | `[]`     | Calendar names to subscribe to. Empty = primary calendar only.                     |
| `ms365.calendar.allowAttendees`       | `false`  | When `false`, attendees on `cal_create_event` are silently dropped.                |
| `ms365.calendar.defaultReminderMinutesBeforeStart` | 15 | Default reminder window for events the agent creates.                            |
| `ms365.calendar.pollingInterval`      | 15       | Minutes between incremental delta polls.                                           |
| `ms365.calendar.pollingBackoff`       | 1        | Minutes; base of exponential backoff on poll errors.                               |
| `ms365.calendar.refreshCron`          | `every sunday at 03:00` | Friendly-cron expression for the full re-walk that reconciles deletions. |
| `ms365.calendar.lookbackDays`         | 365      | Delta window: how far back the poller surfaces events.                             |
| `ms365.calendar.lookaheadDays`        | 730      | Delta window: how far ahead the poller surfaces events.                            |

## Calendar — the agent's surface

Calendar events the plugin discovers flow into the core `calendar_events`
table; agents reach them through the plugin-agnostic `cal_*` tools
(`cal_get_events`, `cal_get_event`, `cal_get_event_attachments`,
`cal_create_event`, `cal_update_event`, `cal_delete_event`,
`cal_attach_file`). Those tools are registered host-side under the DSL group
`core`; a handler enables them via `tools: core` in its frontmatter.

`cal_update_event({id, patch})` accepts a sparse patch — only fields present
on `patch` get changed, everything else stays as Graph had it. Same field set
as `cal_create_event` except `is_videocall` (toggling online-meeting state
on an existing event is brittle across providers, so v1 callers recreate
the event instead). When `ms365.calendar.allowAttendees=false` and the patch
mentions `attendees`, the list is silently cleared before reaching Graph —
mirroring the create-event gate.

`cal_delete_event({id})` calls Graph first; the local cache row is removed
only after the provider confirms, so a transient failure leaves the cache
untouched.

`cal_create_event` accepts a minimal `{subject, start, end}` invocation plus
optional `body` (markdown), `location`, `attendees` (bare email or
`{email, name?}`), `showAs`, `sensitivity`, `reminderMinutesBeforeStart`,
inline `attachments` (≤3MB each), `calendar_id` (name or `pluginId:name`,
defaults to `core.defaultCalendar`), and `is_videocall: true` to request a
Teams meeting (maps onto `isOnlineMeeting + onlineMeetingProvider:
teamsForBusiness` in the Graph payload, so the response carries a `joinUrl`).

When `ms365.calendar.allowAttendees` is `false`, the plugin silently drops
the `attendees` list before hitting Graph and surfaces a `note` field in the
tool's result so the model understands no invitations went out.
