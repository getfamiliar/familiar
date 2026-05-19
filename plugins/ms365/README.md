# Microsoft 365 plugin

Polls one or more Microsoft 365 mailboxes via direct Microsoft Graph calls (no
MCP — see `memory/project_ms365_mcp_incompatible.md` for the rationale) and
emits an event per new mail. Calendar support is on the roadmap and will live
alongside mail in this plugin, sharing the same auth and Graph client.

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

> Body is truncated. Use the ms365_fetch_body tool to get the full body.

**Payload**:

```ts
{
    provider: "ms365",
    upn: string,            // logged-in account upn (safe as path component)
    mailbox: string,        // address polled — primary or shared (safe as path component)
    isShared: boolean,
    from: { name: string | null; address: string; rawAddress: string | null },
    to:    Array<{ name: string | null; address: string; rawAddress: string | null }>,
    cc:    Array<{ name: string | null; address: string; rawAddress: string | null }>,
    subject: string,
    date: string,           // ISO-8601, == receivedDateTime
    messageId: string,      // Graph "id" — used by every ms365_* tool internally
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

All tools resolve the active mail from the triggering event's payload — the
agent never passes a message id or mailbox address. Tool names are
namespaced by the plugin id (`ms365_*`).

| Tool | Effect |
|------|--------|
| `ms365_fetch_body` | Returns the full plain-text body of the current mail. |
| `ms365_fetch_attachments` | Downloads every non-inline attachment into `/scratch/<event-id>/` and returns their paths. |
| `ms365_draft_reply` | Creates a reply draft. `replyAll: true` to include every recipient. |
| `ms365_draft_new` | Creates a brand-new draft under the current mailbox. |
| `ms365_send_reply` | Sends a reply immediately. Gated by `allowSend` + `recipientWhitelist`. |
| `ms365_send_new` | Sends a brand-new mail immediately. Gated by `allowSend` + `recipientWhitelist`. |
| `ms365_draft_forward` | Creates a forwarding draft. |
| `ms365_send_forward` | Forwards the current mail immediately. Gated by `allowSend` + `recipientWhitelist`. |
| `ms365_move` | Moves the current mail. `folder` ∈ `inbox \| archive \| trash`. |

`send_*` tools fall back to creating a draft (and report why) when `allowSend`
is `false` or a recipient violates the whitelist. The agent can surface the
returned reason to the user.

### Attachments

When a message has attachments, the polling loop downloads every non-inline
attachment up-front via the same Graph endpoint the `ms365_fetch_attachments`
tool uses. Bytes that fit Graph's inline-bytes ceiling (~3 MB) ship straight
into the event's `/scratch/<event-id>/` directory; metadata lands in
`payload.attachments` either way. The `attachments` field is `null` only when
the polling-time fetch errored — the agent can still call
`ms365_fetch_attachments` and retry.

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
| `MailboxFolder.Read`           | Resolve the well-known folder ids (`inbox`, `archive`, `deleteditems`) used by `ms365_move`. |
| `MailboxSettings.ReadWrite`    | Reserved for an upcoming out-of-office automation that reads and updates auto-reply settings. |

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

### 4. (Optional) Configure mailboxes / behavior

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
   `Mail.Send.Shared`, `MailboxFolder.Read`, `MailboxSettings.ReadWrite`).
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
```

All subcommands work without the daemon — they talk to Microsoft Graph
directly using the host-side token cache.

## Config reference

| Key                                   | Default  | Meaning                                                                            |
|---------------------------------------|----------|------------------------------------------------------------------------------------|
| `ms365.clientId`                      | bundled  | Entra ID app id; override to use your own registration.                            |
| `ms365.tenantId`                      | `common` | OAuth authority tenant.                                                            |
| `ms365.mail.mailboxes`                | `[]`     | Whitelist; empty = every logged-in account's primary mailbox.                      |
| `ms365.mail.allowSend`                | `false`  | `false` → every `ms365_send_*` becomes a draft.                                    |
| `ms365.mail.recipientWhitelist`       | `[]`     | Allowed addresses or `@domain` anchors when `allowSend=true`.                      |
| `ms365.mail.pollingInterval`          | 15       | Minutes between successful polls.                                                  |
| `ms365.mail.pollingBackoff`           | 1        | Minutes; base of exponential backoff on poll errors. Cap = `pollingInterval × 4`.  |
