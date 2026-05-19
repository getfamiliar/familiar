import { marked } from "marked";

/**
 * Render the agent-supplied markdown body to the HTML Graph wants on
 * the wire. Minimal for v1: no signature, no font wrapping, no inline
 * CSS — those land in a follow-up once we know what the user wants
 * stylistically. The output is a plain `<div>`-less fragment that
 * Graph accepts as `body.content` when `body.contentType` is `"HTML"`.
 *
 * `marked` is configured for GFM line breaks (a single newline is a
 * `<br>`), which matches how a person typing the body in chat
 * naturally thinks about paragraph breaks. The default `marked`
 * behaviour requires two newlines for a paragraph break — that's
 * markdown-correct but surprises the agent often enough to be worth
 * the override.
 */
export function renderMailHtml(markdownBody: string): string {
    return marked.parse(markdownBody, {
        async: false,
        gfm: true,
        breaks: true,
    }) as string;
}
