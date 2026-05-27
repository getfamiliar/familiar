import {
    type ForwardInput,
    type HostContext,
    type MailAttachment,
    type MailFolder,
    type MailProvider,
    type MailSearchHit,
    type MailSearchQuery,
    type NewMailInput,
    type ReplyInput,
    renderMarkdownToHtml,
    signatureToPlainText,
    ToolError,
} from "@getfamiliar/shared";
import { getActiveLogins } from "../auth/ActiveLogins.js";
import type { LoginStore } from "../auth/LoginStore.js";
import {
    GraphClient,
    GraphError,
    type GraphOutgoingBody,
    type GraphRecipient,
} from "../graph/GraphClient.js";
import { FOLDER_IDS, FolderAliasResolver } from "./Folders.js";
import type { MailboxTarget } from "./MailboxMap.js";
import { buildMailHit } from "./MessageShape.js";
import type { MailKind } from "./SentSampler.js";
import { injectStyle, STYLED_TAGS } from "./StyleInjector.js";

/** Plugin id this provider registers under. Matches the package id. */
export const MS365_MAIL_PROVIDER_ID = "ms365";

/**
 * `MailProvider` implementation for Microsoft 365. Stateless apart
 * from the `pluginId` constant; per-call auth is resolved on demand
 * against the module-scoped {@link LoginStore} the daemon seeded
 * during `start`.
 *
 * Provider safety knobs (`mail.allowSend`, `mail.recipientWhitelist`,
 * `calendar.allowAttendees`) are *not* enforced here — the core
 * `mail_*` tools apply those before dispatching. This provider
 * focuses on the Graph API call.
 *
 * Method semantics mirror the {@link MailProvider} contract: ids
 * returned by `draft*` are provider-native (no plugin prefix); the
 * core wraps them with `<pluginId>:<mailbox>:` before handing them
 * back to the agent.
 */
export class Ms365MailProvider implements MailProvider {
    readonly pluginId = MS365_MAIL_PROVIDER_ID;

    /**
     * Mailbox set this provider considers configured, computed once at
     * daemon start by {@link buildMailboxMap}. Search uses it to fan a
     * query across every configured mailbox when the agent didn't pin
     * one; mutating operations still resolve their auth per-call via
     * the active login store (so a token refresh between calls is
     * picked up without rebuilding the map).
     */
    private readonly mailboxMap: readonly MailboxTarget[];

    /**
     * Plugin context — borrowed only for its `getMailStyleTemplate`
     * read path. The provider never mutates ctx state; writes flow
     * through the core `mailstyle_*` tools the extract-style handler
     * calls.
     */
    private readonly ctx: HostContext;

    /**
     * Per-process dedup set for the "no template on disk" warn in
     * `composeBody`. Sends happen often; we want the operator to
     * notice once per mailbox after a daemon boot, not on every
     * outgoing message.
     */
    private readonly warnedMissingTemplate = new Set<string>();

    constructor(ctx: HostContext, mailboxMap: readonly MailboxTarget[] = []) {
        this.ctx = ctx;
        this.mailboxMap = mailboxMap;
    }

    /**
     * Compose the wire body for an outgoing mail by applying the
     * mailbox's style template to the agent-authored markdown:
     *
     *  - No template cache, or no file on disk yet ⇒ pre-feature
     *    fallback: render markdown → HTML and ship it bare, no styling,
     *    no signature.
     *  - `usePlainText` on a `new` mail ⇒ ship the raw markdown as
     *    plain text (markdown reads fine as plain text); append the
     *    signature as plain text below.
     *  - Otherwise ⇒ render markdown → HTML, inject the user's CSS on
     *    every styled tag (unless `usePlainText`, in which case the
     *    reply/forward `comment` is forced into HTML but skips the
     *    style injection), and conditionally append the HTML signature
     *    based on the per-kind boolean.
     *
     * The kind drives signature inclusion only — text style is shared
     * across reply/forward/new because users tend to have one font
     * preference, not three.
     */
    private async composeBody(
        mailbox: string,
        kind: MailKind,
        markdownBody: string,
    ): Promise<GraphOutgoingBody> {
        const tpl = await this.ctx.getMailStyleTemplate(mailbox);
        if (tpl === undefined) {
            // Silent bare-HTML sends are easy to miss — log once per
            // mailbox so the operator notices the missing template and
            // can fire `/mail/extract-style` against it. The set
            // dedups across the daemon's process lifetime; a restart
            // re-warns once.
            if (!this.warnedMissingTemplate.has(mailbox)) {
                this.warnedMissingTemplate.add(mailbox);
                this.ctx.logger.info(
                    `ms365: no mail style template for ${mailbox} — sending bare HTML ` +
                        "without styling or signature. Fire `/mail/extract-style Extract " +
                        `for ${mailbox}\` from cli-chat to populate it.`,
                );
            }
            return { contentType: "HTML", content: renderMarkdownToHtml(markdownBody) };
        }

        if (tpl.usePlainText && kind === "new") {
            const sigText = signatureToPlainText(tpl.signature);
            const content = sigText.length > 0 ? `${markdownBody}\n\n${sigText}` : markdownBody;
            return { contentType: "Text", content };
        }

        let html = renderMarkdownToHtml(markdownBody);
        if (!tpl.usePlainText && tpl.textStyle.length > 0) {
            html = injectStyle(html, tpl.textStyle, STYLED_TAGS);
        }
        if (shouldAppendSignature(kind, tpl.useSignatureOnReplies, tpl.useSignatureOnForwards)) {
            html = `${html}${tpl.signature}`;
        }
        return { contentType: "HTML", content: html };
    }

    async fetchBody(mailbox: string, messageId: string): Promise<string> {
        return mapGraphErrors(async () => {
            const client = await this.clientForMailbox(mailbox);
            return client.getMessageBodyText(mailbox, messageId);
        });
    }

    async fetchAttachments(mailbox: string, messageId: string): Promise<readonly MailAttachment[]> {
        return mapGraphErrors(async () => {
            const client = await this.clientForMailbox(mailbox);
            const raw = await client.getAttachments(mailbox, messageId);
            const out: MailAttachment[] = [];
            for (const att of raw) {
                if (att.isInline) {
                    continue;
                }
                if (typeof att.contentBytes !== "string" || att.contentBytes.length === 0) {
                    continue;
                }
                out.push({
                    name: pickAttachmentName(att.name, att.id),
                    contents: Buffer.from(att.contentBytes, "base64"),
                });
            }
            return out;
        });
    }

    async previewReplyRecipients(
        mailbox: string,
        messageId: string,
        replyAll: boolean,
    ): Promise<readonly string[]> {
        return mapGraphErrors(async () => {
            const client = await this.clientForMailbox(mailbox);
            const { from, to, cc } = await client.getMessageRecipients(mailbox, messageId);
            const out: string[] = [];
            if (from) {
                out.push(from);
            }
            if (!replyAll) {
                return out;
            }
            out.push(...to, ...cc);
            return out;
        });
    }

    async draftReply(mailbox: string, messageId: string, input: ReplyInput): Promise<string> {
        return mapGraphErrors(async () => {
            const client = await this.clientForMailbox(mailbox);
            const body = await this.composeBody(mailbox, "reply", input.bodyMarkdown);
            const draft = await client.createReplyDraft(
                mailbox,
                messageId,
                input.replyAll,
                body.content,
            );
            return draft.id;
        });
    }

    async draftForward(mailbox: string, messageId: string, input: ForwardInput): Promise<string> {
        return mapGraphErrors(async () => {
            const client = await this.clientForMailbox(mailbox);
            const body = await this.composeBody(mailbox, "forward", input.commentMarkdown);
            const draft = await client.createForwardDraft(
                mailbox,
                messageId,
                toGraphRecipients(input.to),
                toGraphRecipients(input.cc),
                body.content,
            );
            return draft.id;
        });
    }

    async draftNew(mailbox: string, input: NewMailInput): Promise<string> {
        return mapGraphErrors(async () => {
            const client = await this.clientForMailbox(mailbox);
            const body = await this.composeBody(mailbox, "new", input.bodyMarkdown);
            const draft = await client.createDraft(mailbox, {
                subject: input.subject,
                body,
                to: toGraphRecipients(input.to),
                cc: toGraphRecipients(input.cc),
            });
            return draft.id;
        });
    }

    async sendReply(mailbox: string, messageId: string, input: ReplyInput): Promise<void> {
        return mapGraphErrors(async () => {
            const client = await this.clientForMailbox(mailbox);
            const body = await this.composeBody(mailbox, "reply", input.bodyMarkdown);
            await client.sendReply(mailbox, messageId, input.replyAll, body.content);
        });
    }

    async sendForward(mailbox: string, messageId: string, input: ForwardInput): Promise<void> {
        return mapGraphErrors(async () => {
            const client = await this.clientForMailbox(mailbox);
            const body = await this.composeBody(mailbox, "forward", input.commentMarkdown);
            await client.sendForward(
                mailbox,
                messageId,
                toGraphRecipients(input.to),
                toGraphRecipients(input.cc),
                body.content,
            );
        });
    }

    async sendNew(mailbox: string, input: NewMailInput): Promise<void> {
        return mapGraphErrors(async () => {
            const client = await this.clientForMailbox(mailbox);
            const body = await this.composeBody(mailbox, "new", input.bodyMarkdown);
            await client.sendMail(mailbox, {
                subject: input.subject,
                body,
                to: toGraphRecipients(input.to),
                cc: toGraphRecipients(input.cc),
            });
        });
    }

    async move(mailbox: string, messageId: string, folder: MailFolder): Promise<void> {
        return mapGraphErrors(async () => {
            const client = await this.clientForMailbox(mailbox);
            await client.moveMessage(mailbox, messageId, FOLDER_IDS[folder]);
        });
    }

    async search(query: MailSearchQuery): Promise<readonly MailSearchHit[]> {
        return mapGraphErrors(async () => {
            if (query.limit <= 0) {
                return [];
            }
            const kql = buildKqlQuery(query);
            const folderId = query.folder ? FOLDER_IDS[query.folder] : null;
            const targets = this.resolveSearchTargets(query.mailbox);
            if (targets.length === 0) {
                return [];
            }
            const hits: MailSearchHit[] = [];
            let remaining = query.limit;
            for (const target of targets) {
                if (remaining <= 0) {
                    break;
                }
                const client = new GraphClient(() => target.auth.getAccessTokenSilent());
                const messages = await client.searchMessages(
                    target.mailbox,
                    kql,
                    folderId,
                    remaining,
                );
                // When the query pinned a folder, every hit is in that
                // folder by construction — skip the per-mailbox lookup.
                // Otherwise build a resolver lazily; the first hit pays
                // the warm-up cost (three Graph round-trips), every
                // subsequent hit in this mailbox is a Map.get.
                const folderResolver =
                    query.folder !== undefined
                        ? null
                        : new FolderAliasResolver((wellKnownName) =>
                              client
                                  .getWellKnownFolderId(target.mailbox, wellKnownName)
                                  .catch(() => null),
                          );
                for (const message of messages) {
                    const folder = query.folder
                        ? query.folder
                        : await (folderResolver as FolderAliasResolver).resolve(
                              message.parentFolderId,
                          );
                    hits.push(
                        buildMailHit({
                            message,
                            mailbox: target.mailbox,
                            isShared: target.isShared,
                            // Search hits don't pre-fetch attachment bytes; agent
                            // can call `mail_fetch_attachments` on demand. `null`
                            // signals "not fetched", matching the poller's
                            // failed-fetch convention.
                            attachments: message.hasAttachments ? null : [],
                            folder,
                        }),
                    );
                    if (hits.length >= query.limit) {
                        break;
                    }
                }
                remaining = query.limit - hits.length;
            }
            return hits;
        });
    }

    /**
     * Pick which mailboxes a search call should visit.
     *
     *  - No `mailbox` filter → every entry in the configured map.
     *  - Filter matches an entry (case-insensitive on the address) →
     *    just that entry.
     *  - Filter doesn't match → best-effort fallback: route through the
     *    active login store (`clientForMailbox`-style) so an unpolled
     *    but reachable mailbox still works on demand. When no login can
     *    reach it, return empty so the caller's fan-in stays clean
     *    (Graph itself would surface the error a beat later anyway).
     */
    private resolveSearchTargets(explicit: string | undefined): readonly MailboxTarget[] {
        if (typeof explicit !== "string" || explicit.length === 0) {
            return this.mailboxMap;
        }
        const lower = explicit.toLowerCase();
        const configured = this.mailboxMap.find((t) => t.mailbox === lower);
        if (configured) {
            return [configured];
        }
        const store: LoginStore | undefined = getActiveLogins() ?? undefined;
        if (!store) {
            return [];
        }
        const auth = store.byUpn(lower);
        if (!auth) {
            return [];
        }
        return [
            {
                upn: lower,
                auth,
                mailbox: lower,
                isShared: false,
            },
        ];
    }

    /**
     * Resolve the {@link GraphClient} bound to whichever active login
     * owns the requested mailbox. Throws agent-readable errors when no
     * login store has been seeded (daemon not started?) or when no
     * registered login can reach the mailbox (typo? wrong account?).
     */
    private async clientForMailbox(mailbox: string): Promise<GraphClient> {
        const store: LoginStore | undefined = getActiveLogins() ?? undefined;
        if (!store) {
            throw new Error(
                "no active ms365 logins; run `./cli.sh ms365 login` and restart the daemon",
            );
        }
        const auth = store.byUpn(mailbox);
        if (!auth) {
            throw new Error(
                `no active ms365 login for ${mailbox}; run \`./cli.sh ms365 login\` to add one`,
            );
        }
        return new GraphClient(() => auth.getAccessTokenSilent());
    }
}

/**
 * Decide whether to append the user's signature given the mail kind
 * and the two per-kind booleans. New mails always get the signature
 * (no reason yet to make that conditional); reply / forward decisions
 * follow the template flags.
 */
function shouldAppendSignature(
    kind: MailKind,
    useSignatureOnReplies: boolean,
    useSignatureOnForwards: boolean,
): boolean {
    if (kind === "new") {
        return true;
    }
    if (kind === "reply") {
        return useSignatureOnReplies;
    }
    return useSignatureOnForwards;
}

/**
 * Run `body` and translate any thrown {@link GraphError} into a
 * {@link ToolError} carrying Graph's `code` / cleaned `graphMessage`
 * / HTTP `status`. Non-Graph throws propagate unchanged. Wrapping
 * happens at the provider boundary so the agent-facing mail tools
 * don't have to know about Graph's exception shape.
 */
async function mapGraphErrors<T>(body: () => Promise<T>): Promise<T> {
    try {
        return await body();
    } catch (err) {
        if (err instanceof GraphError) {
            throw new ToolError(err.code ?? "GraphError", err.graphMessage, err.status);
        }
        throw err;
    }
}

/**
 * Convert bare email strings to the `{address, name?}` shape Graph
 * expects. Names embedded in the address (e.g. `"Anna <anna@x>"`) are
 * passed through verbatim — Outlook treats them as fully-qualified
 * mailbox headers, which is what the agent intended.
 */
function toGraphRecipients(addresses: readonly string[]): readonly GraphRecipient[] {
    return addresses.map((address) => ({ address }));
}

/**
 * Assemble a Graph KQL `$search` expression from the agent-facing
 * search predicates. Components are joined with AND. Date predicates
 * use KQL's `received` keyword (Graph maps to `receivedDateTime`); the
 * `after`/`before` values arrive as UTC ISO instants — KQL accepts
 * `yyyy-MM-ddTHH:mm:ssZ` directly. The contact predicate fans across
 * `from:`, `to:`, `cc:` so a single string captures "any mail
 * involving this person".
 *
 * The host pre-validates that at least one predicate is set; an empty
 * KQL string would make Graph return every mail in the folder, which
 * is rarely what the agent intended. (`buildKqlQuery` itself doesn't
 * enforce this — the host's tool layer surfaces the clearer error.)
 */
function buildKqlQuery(query: MailSearchQuery): string {
    const parts: string[] = [];
    if (query.text) {
        parts.push(query.text.trim());
    }
    if (query.contact) {
        const c = query.contact.trim();
        parts.push(`(from:${c} OR to:${c} OR cc:${c})`);
    }
    if (query.after) {
        parts.push(`received>=${query.after}`);
    }
    if (query.before) {
        parts.push(`received<${query.before}`);
    }
    return parts.join(" AND ");
}

/**
 * Pick a basename safe to surface as a downloaded attachment. Falls
 * back to `attachment-<id>` when Graph emits an empty `name` (rare;
 * usually for unnamed inline parts that slipped past the inline
 * filter) and strips path separators so the value is safe as a
 * basename for the scratch directory.
 */
function pickAttachmentName(name: string, id: string): string {
    const cleaned = name.replace(/[/\\]/g, "_").replace(/^\.+/, "");
    if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
        return `attachment-${id.replace(/[/\\]/g, "_")}`;
    }
    return cleaned;
}
