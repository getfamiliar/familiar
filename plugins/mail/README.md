# Mail plugin

Polls one or more mail MCPs and emits an event per new mail. Day-1 provider is
**Microsoft 365** via [`@softeria/ms-365-mcp-server`](https://www.npmjs.com/package/@softeria/ms-365-mcp-server).
Adding Gmail, Proton, or another provider later is a sibling implementation
under `src/providers/<id>/` — no edits to the orchestration core.

The plugin runs on operational defaults — no `mail:` block in `config.yml` is
required. Real enablement is gated on each provider's MCP being declared in
`config/mcp.yml` and the user being logged in.

## What the agent sees

For every new mail the plugin emits a `mail:<provider>` event (today
`mail:o365`). The container's handler resolver picks up the most specific
handler available — `workspace/mail/o365/index.md` first, falling back to
`workspace/mail/index.md`. The handler decides what to do; the plugin's job is
only to surface the mail.

**Prompt** the handler receives:

> A new e-mail was received from `<from-display>` with subject `"<subject>"`,
> see payload for metadata. The body starts with: `<bodyPreview>`

When the body preview is at Graph's truncation cap (255 chars), the prompt
ends with:

> Body is truncated. If needed get full body with get-mail-message tool.

**Payload**:

```ts
{
    provider: "o365",
    account: string,        // logged-in account email (always validated — safe as a path component)
    mailbox: string,        // address polled (always validated — safe as a path component)
    isShared: boolean,
    from: { name: string | null; address: string; rawAddress: string | null },
    to:    Array<{ name: string | null; address: string; rawAddress: string | null }>,
    cc:    Array<{ name: string | null; address: string; rawAddress: string | null }>,
    subject: string,
    date: string,           // ISO-8601, == receivedDateTime
    messageId: string,      // Graph "id" — pass to get-mail-message
    internetMessageId: string,
    hasAttachments: boolean,
    attachments: Array<{
        id: string,
        name: string,
        contentType: string,
        size: number,         // bytes
        isInline: boolean,
    }> | null,
}
```

### Attachments

When a message has attachments, the plugin issues one extra MCP call per
message (`get-shared-mailbox-message` with `$expand=attachments(...)`) and
inlines metadata for each item — no bytes. The `attachments` field follows
three shapes:

- `[]` — `hasAttachments` is `false`, no fetch issued.
- `[…]` — fetch succeeded; one entry per attachment.
- `null` — the per-message fetch failed (e.g. transient throttling). The
  handler can retry via the same MCP tool itself.

Bytes are deliberately not included. Handlers that need the file contents
should call `download-bytes` / `get-attachment` with the `id` from this
list and the `messageId` from the payload.

### Address safety

Every address that lands in the payload is run through a strict validator
(`isSafeEmailAddress` in `src/providers/o365/Sanitize.ts`). The `address`
field on `from` / `to` / `cc` and the top-level `account` / `mailbox` strings
are **always safe to use as filename components** — handlers can do
`workspace/people/<address>.md` without any further escaping.

If the upstream value fails validation (path separators, `..`, control
characters, malformed shape, etc.) the field carries the safe sentinel
`invalid@invalid.invalid` and the raw, untrusted bytes are preserved on
`rawAddress`. **Handlers must never use `rawAddress` as a path component.** It
exists so the agent can recognize and flag a spoofed / malformed sender; for
display, the prompt text already prefixes such senders with `[suspicious
sender]`.

Idempotency key: `mail:<provider>:<internetMessageId>`. The bus rejects
duplicates, so each mail produces at most one event ever — across re-polls,
full inbox walks, and daemon restarts.

## Setting up Microsoft 365 (`o365`)

### 1. Declare the MCP

Add an entry to `config/mcp.yml`:

```yaml
ms365:
  title: Softeria Microsoft 365
  description: Microsoft 365 / Graph access.
  source: npm
  package: "@softeria/ms-365-mcp-server"
  args:
    - "--org-mode"
```

`--org-mode` is required for organization tenants. Don't add `--read-only`
here unless every handler you'll ever write is happy reading — sending /
mark-read tools live in the same MCP.

The `mcp.yml` key (here `ms365`) can be anything; the plugin matches by
package name, not key.

### 2. Authenticate

```bash
./cli.sh mcp call ms365 -- --login
```

Follow the device-code prompt. The token is persisted under
`tmp/mcp-mount-ms365/` and is reused by the bastion-managed MCP at runtime.

`mcp call` runs the container with whatever `args:` you declared in
`mcp.yml` first, then appends your `-- <tail>` — so the OAuth scopes
that get cached match what the bastion later asks for silently (e.g.
`--org-mode`). You don't have to re-list those flags after `--`.

### 3. Verify

```bash
./cli.sh mail o365 status
```

Expected output:

```
✓ Microsoft 365 (mcp key: ms365)
  Logged-in accounts:
    - user@org.com
```

### 4. (Optional) Inspect reachable mailboxes

```bash
./cli.sh mail o365 list-mailboxes
```

Tries `list-users` to enumerate shared mailboxes — this requires `--org-mode`
on the MCP **and** the signed-in account holding admin scope. When enumeration
isn't possible, only primary mailboxes and explicitly configured shared
mailboxes appear in the table.

### 5. (Optional) Configure mailboxes / behavior

```yaml
mail:
  pollingInterval: 15      # minutes; default 15
  pollingBackoff: 1        # minutes; base for exponential backoff; default 1
  o365:
    onlyNew: false         # true = ignore historical mail on first start
    mailboxes:             # empty/omitted = all primary mailboxes
      - adam@business.com
      - service@business.com
```

The `mailboxes:` whitelist applies across all logged-in accounts. Entries that
match a logged-in account's primary email are polled as that account's own
inbox; entries that don't are tried as shared mailboxes (any logged-in account
with delegated read access wins).

## CLI reference

```
./cli.sh mail                              # show registered providers
./cli.sh mail o365 status                  # login state for Microsoft 365
./cli.sh mail o365 list-mailboxes          # reachable mailboxes (own + shared)
```

`./cli.sh mail o365 list-mailboxes` needs the daemon up (it routes MCP calls
through the live bastion). `status` works either way — it's a single
`verify-login` call.

## Config reference

| Key                          | Default | Meaning                                                                            |
|------------------------------|---------|------------------------------------------------------------------------------------|
| `mail.pollingInterval`       | 15      | Minutes between polls per active provider.                                         |
| `mail.pollingBackoff`        | 1       | Minutes; base of exponential backoff on poll errors. Cap = `pollingInterval × 4`.  |
| `mail.<provider>.onlyNew`    | false   | When `true`, the first watermark for a fresh mailbox is set to "now" (no history). |
| `mail.<provider>.mailboxes`  | `[]`    | Whitelist; empty = every logged-in account's primary mailbox.                      |

## Adding more providers

Create `src/providers/<id>/<Id>Provider.ts` that `implements MailProvider`
(see `src/providers/MailProvider.ts`), add a `buildCommands` and an
`isLoggedIn`, then list it in `src/providers/Registry.ts`. The orchestration
core auto-detects it via its `packageName` against `mcp.yml` and threads it
through the polling loop.
