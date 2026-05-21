import { buildMailId, type MailAttachmentMeta, type MailSearchHit } from "@getfamiliar/shared";
import type { GraphMailMessage } from "../graph/GraphClient.js";
import { flatAddress } from "./AddressFormat.js";
import type { ResolvedFolderAlias } from "./Folders.js";
import { MS365_MAIL_PROVIDER_ID } from "./Ms365MailProvider.js";

/**
 * Shape a `GraphMailMessage` into the canonical mail payload the agent
 * sees. This is the single source of truth for both the polling loop
 * (which embeds it as `event.payload`) and `mail_search` (which streams
 * one hit per JSONL line) — keeping the two on one builder means the
 * agent's downstream `mail:new` handler code path works on search hits
 * verbatim.
 *
 * `attachments` is whatever metadata is available at the call site:
 *
 *   - the poller passes a pre-fetched metadata array (it also has the
 *     bytes ready for `event.files`);
 *   - `mail_search` passes `null` when `hasAttachments` is true, so the
 *     agent knows to call `mail_fetch_attachments` on demand without
 *     paying an extra Graph round-trip per hit;
 *   - both pass `[]` when the message carries no attachments.
 */
export function buildMailHit(args: {
    readonly message: GraphMailMessage;
    readonly mailbox: string;
    readonly isShared: boolean;
    readonly attachments: readonly MailAttachmentMeta[] | null;
    /**
     * Folder alias the agent should see for this hit. The caller
     * supplies it because folder resolution lives at the call boundary:
     * the poller passes `"inbox"` (it only walks the inbox folder),
     * and `mail_search` either echoes the agent's `folder` filter when
     * one was supplied or runs a per-mailbox lookup against
     * `message.parentFolderId` otherwise.
     */
    readonly folder: ResolvedFolderAlias;
}): MailSearchHit {
    const { message, mailbox, isShared, attachments, folder } = args;
    const from = message.from
        ? flatAddress(message.from)
        : { name: null, address: "", rawAddress: null };
    return {
        mail_id: buildMailId(MS365_MAIL_PROVIDER_ID, mailbox, message.id),
        isShared,
        from,
        to: (message.toRecipients ?? []).map(flatAddress),
        cc: (message.ccRecipients ?? []).map(flatAddress),
        subject: message.subject ?? "(no subject)",
        date: message.receivedDateTime,
        internetMessageId: message.internetMessageId,
        hasAttachments: message.hasAttachments,
        attachments,
        folder,
    };
}
