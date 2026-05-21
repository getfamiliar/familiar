import { marked } from "marked";

/**
 * Render the agent-supplied markdown body to an HTML fragment suitable for
 * providers that want HTML on the wire (Microsoft Graph mail/calendar bodies,
 * future SMTP/IMAP plugins, etc.). Output is a plain fragment — no `<html>`,
 * `<head>`, or inline CSS — so callers can wrap it however the destination
 * needs.
 *
 * `marked` is configured for GFM line breaks (a single newline becomes a
 * `<br>`), which matches how a person typing the body in chat naturally
 * thinks about paragraph breaks. The default `marked` behaviour requires two
 * newlines for a paragraph break — that's markdown-correct but surprises
 * agents and humans often enough to be worth the override.
 */
export function renderMarkdownToHtml(markdownBody: string): string {
    return marked.parse(markdownBody, {
        async: false,
        gfm: true,
        breaks: true,
    }) as string;
}
