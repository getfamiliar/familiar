import path from "node:path";

/**
 * Per-mailbox styling commands the send path applies to every outgoing
 * mail. Two extracted fields (signature, textStyle) plus three booleans
 * that capture per-kind habits (whether the signature should be appended
 * on replies / forwards, and whether the user predominantly writes
 * plain text).
 *
 * Named `MailStyleTemplate` (not `MailTemplate`) because the JSON
 * carries styling commands, not a full template body — the word
 * "template" alone over-claims.
 *
 * Storage is provider-agnostic: the file lives at
 * `data/mail/templates/<mailbox>/<name>.json` so a future Gmail / IMAP
 * provider can write its own templates without colliding with ms365.
 */
export interface MailStyleTemplate {
    /**
     * HTML fragment — the user's signature block as Outlook stamps it
     * onto sent mail. No `<html>`/`<head>`/`<body>` wrapper; the send
     * path appends this verbatim at the end of the rendered body.
     */
    readonly signature: string;
    /**
     * CSS declarations the user's mails use by default, packed into a
     * single attribute-ready string (e.g.
     * `"font-family: Calibri; font-size: 11pt; color: #1f1f1f"`).
     * Injected as a `style="…"` attribute on every block-level element
     * the markdown→HTML renderer emits, since most clients ignore
     * `<style>` blocks and require inline styling per element.
     */
    readonly textStyle: string;
    /**
     * Dominant `body.contentType` across the user's sampled Sent mails.
     * `true` when the user predominantly writes plain text — the send
     * path then ships new mails with `body.contentType: "Text"` and
     * the raw markdown body (markdown reads fine as plain text).
     */
    readonly usePlainText: boolean;
    /**
     * True when the signature appears in ≥ half of the user's reply
     * samples. Drives whether the send path appends the signature on
     * reply paths. Empty reply bucket ⇒ `false` (no evidence; default
     * to "don't sign").
     */
    readonly useSignatureOnReplies: boolean;
    /** Same as {@link useSignatureOnReplies} for the forward bucket. */
    readonly useSignatureOnForwards: boolean;
}

/** Defaults applied when a `mailstyle_update` call creates a new file. */
export const MAIL_STYLE_TEMPLATE_DEFAULTS: MailStyleTemplate = {
    signature: "",
    textStyle: "",
    usePlainText: false,
    useSignatureOnReplies: false,
    useSignatureOnForwards: false,
};

/**
 * Absolute path of a per-mailbox style template. `name` defaults to
 * `"default"` — that's the single template every mailbox always has.
 * Multi-template support (e.g. business vs. personal signature) plugs
 * in by passing a different name; the directory layout is already
 * forward-compatible.
 */
export function mailStyleTemplatePath(
    dataDir: string,
    mailbox: string,
    name: string = "default",
): string {
    return path.join(dataDir, "mail", "templates", mailbox, `${name}.json`);
}

/**
 * Strip an HTML signature fragment down to a plain-text rendition the
 * `usePlainText` new-mail branch can append below the markdown body.
 * Three regex passes:
 *  1. `<br>` and `</p>` / `</div>` / `</li>` close-tags become a single
 *     newline so paragraph and list-item structure survives.
 *  2. Every remaining tag is dropped.
 *  3. The five common HTML entities are decoded.
 * Trailing whitespace on each line is trimmed and runs of 3+ blank
 * lines are collapsed to a single blank line so the result reads
 * cleanly in a plain-text mail body.
 */
export function signatureToPlainText(html: string): string {
    const withBreaks = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr)>/gi, "\n");
    const stripped = withBreaks.replace(/<[^>]+>/g, "");
    const decoded = stripped
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"');
    return decoded
        .split("\n")
        .map((line) => line.replace(/\s+$/g, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
