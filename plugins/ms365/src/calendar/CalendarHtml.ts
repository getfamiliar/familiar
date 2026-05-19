import { marked } from "marked";

/**
 * Render the agent-supplied markdown body for a calendar event into
 * Graph's `body.content` HTML. Same configuration as the mail side
 * (`renderMailHtml`) so the look is consistent: GFM, single-newline
 * line breaks. Kept as its own module to avoid a circular import
 * between the mail and calendar trees.
 */
export function renderCalendarHtml(markdownBody: string): string {
    return marked.parse(markdownBody, {
        async: false,
        gfm: true,
        breaks: true,
    }) as string;
}
