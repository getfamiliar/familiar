import {
    type ForwardInput,
    type MailAttachment,
    type MailFolder,
    type MailProvider,
    type MailSearchHit,
    type MailSearchQuery,
    type NewMailInput,
    type ReplyInput,
    renderMarkdownToHtml,
    type ToolFailureAdaptor,
} from "@getfamiliar/shared";
import { getActiveLogins } from "../auth/ActiveLogins.js";
import type { LoginStore } from "../auth/LoginStore.js";
import { GraphClient, GraphError, type GraphRecipient } from "../graph/GraphClient.js";
import { FOLDER_IDS } from "./Folders.js";
import type { MailboxTarget } from "./MailboxMap.js";
import { buildMailHit } from "./MessageShape.js";

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

    constructor(mailboxMap: readonly MailboxTarget[] = []) {
        this.mailboxMap = mailboxMap;
    }

    async fetchBody(mailbox: string, messageId: string): Promise<string> {
        const client = await this.clientForMailbox(mailbox);
        return client.getMessageBodyText(mailbox, messageId);
    }

    async fetchAttachments(mailbox: string, messageId: string): Promise<readonly MailAttachment[]> {
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
    }

    async previewReplyRecipients(
        mailbox: string,
        messageId: string,
        replyAll: boolean,
    ): Promise<readonly string[]> {
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
    }

    async draftReply(mailbox: string, messageId: string, input: ReplyInput): Promise<string> {
        const client = await this.clientForMailbox(mailbox);
        const html = renderMarkdownToHtml(input.bodyMarkdown);
        const draft = await client.createReplyDraft(mailbox, messageId, input.replyAll, html);
        return draft.id;
    }

    async draftForward(mailbox: string, messageId: string, input: ForwardInput): Promise<string> {
        const client = await this.clientForMailbox(mailbox);
        const html = renderMarkdownToHtml(input.commentMarkdown);
        const draft = await client.createForwardDraft(
            mailbox,
            messageId,
            toGraphRecipients(input.to),
            toGraphRecipients(input.cc),
            html,
        );
        return draft.id;
    }

    async draftNew(mailbox: string, input: NewMailInput): Promise<string> {
        const client = await this.clientForMailbox(mailbox);
        const html = renderMarkdownToHtml(input.bodyMarkdown);
        const draft = await client.createDraft(mailbox, {
            subject: input.subject,
            bodyHtml: html,
            to: toGraphRecipients(input.to),
            cc: toGraphRecipients(input.cc),
        });
        return draft.id;
    }

    async sendReply(mailbox: string, messageId: string, input: ReplyInput): Promise<void> {
        const client = await this.clientForMailbox(mailbox);
        const html = renderMarkdownToHtml(input.bodyMarkdown);
        await client.sendReply(mailbox, messageId, input.replyAll, html);
    }

    async sendForward(mailbox: string, messageId: string, input: ForwardInput): Promise<void> {
        const client = await this.clientForMailbox(mailbox);
        const html = renderMarkdownToHtml(input.commentMarkdown);
        await client.sendForward(
            mailbox,
            messageId,
            toGraphRecipients(input.to),
            toGraphRecipients(input.cc),
            html,
        );
    }

    async sendNew(mailbox: string, input: NewMailInput): Promise<void> {
        const client = await this.clientForMailbox(mailbox);
        const html = renderMarkdownToHtml(input.bodyMarkdown);
        await client.sendMail(mailbox, {
            subject: input.subject,
            bodyHtml: html,
            to: toGraphRecipients(input.to),
            cc: toGraphRecipients(input.cc),
        });
    }

    async move(mailbox: string, messageId: string, folder: MailFolder): Promise<void> {
        const client = await this.clientForMailbox(mailbox);
        await client.moveMessage(mailbox, messageId, FOLDER_IDS[folder]);
    }

    async search(query: MailSearchQuery): Promise<readonly MailSearchHit[]> {
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
            const messages = await client.searchMessages(target.mailbox, kql, folderId, remaining);
            for (const message of messages) {
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
                    }),
                );
                if (hits.length >= query.limit) {
                    break;
                }
            }
            remaining = query.limit - hits.length;
        }
        return hits;
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

    readonly adaptError: ToolFailureAdaptor = (err) => {
        if (err instanceof GraphError) {
            return {
                status: err.status,
                code: err.code ?? "GraphError",
                message: err.graphMessage,
            };
        }
        return null;
    };

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
