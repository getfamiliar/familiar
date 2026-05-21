import type { ToolFailureAdaptor } from "./ToolFailure.js";

/**
 * Plugin-agnostic mail model. Lives in `shared/` because both the host
 * (which owns the `mail_*` agent tools and the safety gate) and the
 * plugin providers (which translate the typed interface into provider
 * API calls) trade in the same shapes.
 *
 * The core has no mail cache of its own — providers fetch live every
 * time. Plugin pollers still emit `mail:<plugin>` events to wake
 * handlers, but the persisted entity is the event row; the mail body
 * and attachments are pulled on demand through the provider.
 *
 * **Mail ids** are provider-prefixed strings: `<pluginId>:<mailbox>:<realId>`.
 * The mailbox segment lets the host route a tool call to the correct
 * provider AND the correct logged-in account without needing a separate
 * mailbox registry. {@link buildMailId} / {@link parseMailId} are the
 * canonical helpers; raw string concatenation is forbidden.
 *
 * **Folders.** The core uses three abstract aliases — `inbox`, `archive`,
 * `trash` — which each provider maps to its native folder names
 * (e.g. ms365 → `inbox`, `archive`, `deleteditems`; gmail eventually →
 * `INBOX`, `[Gmail]/All Mail`, `[Gmail]/Trash`).
 */

export type MailFolder = "inbox" | "archive" | "trash";

/**
 * One downloaded attachment. The core tool stages these into the
 * agentrun's scratch directory; the provider supplies the raw bytes.
 */
export interface MailAttachment {
    readonly name: string;
    readonly contents: Buffer;
}

/**
 * Composition input for {@link MailProvider.draftReply} /
 * {@link MailProvider.sendReply}. The body is markdown; providers render
 * to their native body format (HTML for Graph) before dispatch.
 */
export interface ReplyInput {
    readonly bodyMarkdown: string;
    /** When `true`, address every recipient on the original mail. */
    readonly replyAll: boolean;
}

/**
 * Composition input for {@link MailProvider.draftForward} /
 * {@link MailProvider.sendForward}. The optional comment renders above
 * the quoted original. Original attachments are carried over by the
 * provider where possible.
 */
export interface ForwardInput {
    readonly to: readonly string[];
    readonly cc: readonly string[];
    readonly commentMarkdown: string;
}

/**
 * Composition input for a brand-new mail (no source message). The
 * "from" mailbox is passed separately to {@link MailProvider.draftNew} /
 * {@link MailProvider.sendNew} as the first argument so the same shape
 * carries through every send/draft variant.
 */
export interface NewMailInput {
    readonly to: readonly string[];
    readonly cc: readonly string[];
    readonly subject: string;
    readonly bodyMarkdown: string;
}

/**
 * The contract a provider plugin implements + registers via
 * {@link MailApi.registerProvider}. The host's `mail_*` tools dispatch
 * here by parsing the mail id's `<pluginId>:` prefix and looking the
 * provider up in the registry.
 *
 * Methods return raw provider-native ids; the core wraps them with
 * the `<pluginId>:<mailbox>:` prefix before handing them back to the
 * agent. That way every id the agent sees is self-routing.
 *
 * Provider safety (send guards, attendee stripping, etc.) is **not**
 * the provider's concern — those policies live in core (`MailSafety`
 * in the host). Providers focus on the API call.
 */
export interface MailProvider {
    /** Identifies this provider in the registry. Matches the plugin id. */
    readonly pluginId: string;

    /** Fetch the plain-text body of one message. */
    fetchBody(mailbox: string, messageId: string): Promise<string>;

    /** Download every non-inline attachment as in-memory buffers. */
    fetchAttachments(mailbox: string, messageId: string): Promise<readonly MailAttachment[]>;

    /**
     * Inspect an existing message and return the recipient set a reply
     * would address (sender always; to/cc lists when `replyAll`). Used
     * by core to gate `send_reply` against the safety whitelist *before*
     * the send call; saves one round trip in the gated path and lets
     * the agent see the recipients in the result envelope.
     */
    previewReplyRecipients(
        mailbox: string,
        messageId: string,
        replyAll: boolean,
    ): Promise<readonly string[]>;

    /** Create a draft reply. Returns the provider-native draft id. */
    draftReply(mailbox: string, messageId: string, input: ReplyInput): Promise<string>;

    /** Create a draft forward. Returns the provider-native draft id. */
    draftForward(mailbox: string, messageId: string, input: ForwardInput): Promise<string>;

    /** Create a brand-new draft under `mailbox`. Returns its id. */
    draftNew(mailbox: string, input: NewMailInput): Promise<string>;

    /**
     * Compose and dispatch a reply immediately. The core has already
     * cleared the safety gate by the time this is called.
     */
    sendReply(mailbox: string, messageId: string, input: ReplyInput): Promise<void>;

    /** Compose and dispatch a forward immediately. */
    sendForward(mailbox: string, messageId: string, input: ForwardInput): Promise<void>;

    /** Compose and dispatch a brand-new mail immediately. */
    sendNew(mailbox: string, input: NewMailInput): Promise<void>;

    /** Move a message to one of the abstract folder aliases. */
    move(mailbox: string, messageId: string, folder: MailFolder): Promise<void>;

    /**
     * Optional mapper from a thrown provider-specific exception to the
     * {@link ToolFailure} envelope. Lets Graph's `ErrorItemNotFound`
     * etc. flow through to the agent verbatim instead of collapsing to
     * the generic `{status:0, code:"ToolError"}` arm.
     */
    readonly adaptError?: ToolFailureAdaptor;
}

/**
 * Capabilities the host exposes to plugins for mail data. Reached via
 * `ctx.mail` on a plugin's `HostContext`. Tiny by design: there is no
 * mail cache in core, so the only thing plugins do here is register
 * their provider during `start()`.
 */
export interface MailApi {
    /**
     * Register the create / send / fetch callbacks a provider plugin
     * implements. Throws if the same `pluginId` registers twice — a
     * wiring bug, not a feature.
     */
    registerProvider(provider: MailProvider): void;
}

/**
 * Build a self-routing mail id from the three segments. Format:
 * `<pluginId>:<mailbox>:<realId>`. The id is what flows through tool
 * args, event payloads, and agent prompts — the agent never sees the
 * three segments separately.
 *
 * No escaping is applied: mailboxes containing literal `:` (rare;
 * RFC 5321 allows quoted local parts) are unsupported. Graph ids
 * routinely contain `=`, `+`, `/` but never `:`, so the parse split is
 * unambiguous in practice.
 */
export function buildMailId(pluginId: string, mailbox: string, realId: string): string {
    if (pluginId.length === 0 || pluginId.includes(":")) {
        throw new Error(`pluginId must be non-empty and ":"-free: "${pluginId}"`);
    }
    if (mailbox.length === 0 || mailbox.includes(":")) {
        throw new Error(`mailbox must be non-empty and ":"-free: "${mailbox}"`);
    }
    if (realId.length === 0) {
        throw new Error("realId must be non-empty");
    }
    return `${pluginId}:${mailbox}:${realId}`;
}

/**
 * Parse a mail id back into its three segments. The split is on the
 * first two `:` characters; anything after the second colon is the
 * real id (which provider implementations may use freely).
 *
 * @throws If the id has fewer than two `:` separators or any segment
 *   is empty. The error message names the offending input so a bad
 *   id surfaced from agent args produces an actionable tool failure.
 */
export function parseMailId(id: string): {
    readonly pluginId: string;
    readonly mailbox: string;
    readonly realId: string;
} {
    const first = id.indexOf(":");
    if (first <= 0) {
        throw new Error(`mail id "${id}" is malformed: expected "<plugin>:<mailbox>:<realId>"`);
    }
    const second = id.indexOf(":", first + 1);
    if (second <= first + 1) {
        throw new Error(`mail id "${id}" is malformed: missing mailbox segment`);
    }
    const realId = id.slice(second + 1);
    if (realId.length === 0) {
        throw new Error(`mail id "${id}" is malformed: empty real-id segment`);
    }
    return {
        pluginId: id.slice(0, first),
        mailbox: id.slice(first + 1, second),
        realId,
    };
}
