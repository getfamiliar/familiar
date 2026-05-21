import {
    type ForwardInput,
    type MailAttachment,
    type MailFolder,
    type MailProvider,
    type NewMailInput,
    type ReplyInput,
    renderMarkdownToHtml,
    type ToolFailureAdaptor,
} from "@getfamiliar/shared";
import { getActiveLogins } from "../auth/ActiveLogins.js";
import type { LoginStore } from "../auth/LoginStore.js";
import { GraphClient, GraphError, type GraphRecipient } from "../graph/GraphClient.js";
import { FOLDER_IDS } from "./Folders.js";

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
