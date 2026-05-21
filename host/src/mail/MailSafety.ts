import type { ConfigService } from "@getfamiliar/shared";

/**
 * Result of the send-safety check applied by `mail_send_*` tools
 * before dispatching to a provider. When `send` is `false`, the
 * matching `mail_draft_*` provider call is invoked instead and
 * {@link reason} is surfaced verbatim in the tool's result envelope so
 * the agent can pass it back to the user.
 */
export type SendDecision =
    | { readonly send: true }
    | { readonly send: false; readonly reason: string };

/**
 * Owner of the cross-provider send-safety policy. Reads two keys:
 *
 *   - `mail.allowSend` (boolean, default `false`) — master switch.
 *     `false` ⇒ every `mail_send_*` call is downgraded to its draft
 *     counterpart, regardless of recipients.
 *   - `mail.recipientWhitelist` (string[], default `[]`) — only
 *     consulted when `allowSend=true`. Empty list ⇒ no restriction.
 *     Entries are either full addresses (`user@host`) or domain anchors
 *     (`@host`); a recipient matches if its address equals an entry
 *     verbatim or shares a domain with an `@host` entry.
 *
 * The same gate previously lived inside `plugins/ms365/src/mail/MailTools.ts`
 * scoped to ms365. Lifting it here means every future provider (gmail,
 * imap, etc.) inherits the safety for free — providers can't forget to
 * enforce it because they never see the call when the gate denies.
 */
export class MailSafety {
    private readonly config: ConfigService;

    constructor(config: ConfigService) {
        this.config = config;
    }

    /**
     * Apply the `allowSend` + `recipientWhitelist` rules. Returns
     * `{send:true}` when every recipient is permitted, otherwise
     * `{send:false, reason}` with a sentence-form explanation that
     * names the first offending recipient (or the allowSend switch).
     */
    checkSendAllowed(recipients: readonly string[]): SendDecision {
        const allowSend = this.config.getBool("mail.allowSend", false) === true;
        if (!allowSend) {
            return {
                send: false,
                reason:
                    "mail.allowSend is false in config; created a draft instead. " +
                    "Set mail.allowSend to true in config.yml to enable direct sending.",
            };
        }
        const whitelistRaw = this.config.getArray("mail.recipientWhitelist", []);
        const whitelist = readStringList(whitelistRaw).map((e) => e.toLowerCase());
        if (whitelist.length === 0) {
            return { send: true };
        }
        for (const recipient of recipients) {
            const addr = recipient.toLowerCase();
            const at = addr.indexOf("@");
            const domain = at >= 0 ? `@${addr.slice(at + 1)}` : "";
            if (whitelist.includes(addr) || (domain.length > 1 && whitelist.includes(domain))) {
                continue;
            }
            return {
                send: false,
                reason:
                    `recipient ${recipient} is not in mail.recipientWhitelist; created a draft instead. ` +
                    "Add the address or its @domain to mail.recipientWhitelist in config.yml to permit direct sending.",
            };
        }
        return { send: true };
    }
}

/**
 * Coerce an arbitrary array from the YAML config into a `string[]`.
 * Non-string entries are silently dropped so a malformed YAML cell
 * (e.g. a number in the recipient list) doesn't crash the safety check;
 * the worst case is the agent gets blocked on a recipient it could
 * have sent to.
 */
function readStringList(input: readonly unknown[]): readonly string[] {
    const out: string[] = [];
    for (const entry of input) {
        if (typeof entry === "string" && entry.length > 0) {
            out.push(entry);
        }
    }
    return out;
}
