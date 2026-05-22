/**
 * The block-level tags the send-path styling step decorates with the
 * user's `textStyle` CSS. Picked because they're the elements
 * `renderMarkdownToHtml` actually emits AND the ones Outlook/Gmail
 * reset to client defaults when no inline `style=` attribute is
 * present. Headings and table cells matter because markdown renders
 * to them routinely and clients are particularly aggressive about
 * resetting their fonts.
 */
export const STYLED_TAGS: readonly string[] = [
    "p",
    "li",
    "div",
    "span",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "td",
    "th",
];

/**
 * Inject `style="<css>"` onto every opening tag in `tags` that doesn't
 * already carry a `style=` attribute. Single regex per tag — body-sized
 * inputs make this cheap and we avoid a DOM-parser dependency.
 *
 *  - Tags with an existing `style=` are left alone (defensive: the
 *    extracted signature may have its own inline styles we don't want
 *    to clobber when the caller happens to wrap it before injection).
 *  - Self-closing tags (`<br/>`, `<hr/>`) aren't in the list and are
 *    left alone.
 *  - Empty `css` short-circuits to the input unchanged.
 */
export function injectStyle(html: string, css: string, tags: readonly string[]): string {
    if (css.length === 0 || tags.length === 0) {
        return html;
    }
    let out = html;
    for (const tag of tags) {
        // `<tag` followed by an optional attribute list with no `style=`,
        // then the closing `>`. The negative lookahead on `style=`
        // prevents double-injection. Word-boundary on the tag name so
        // `<span` doesn't accidentally match `<spanish>` (hypothetical).
        const re = new RegExp(`<(${tag})\\b((?:(?!\\bstyle\\s*=)[^>])*?)>`, "gi");
        out = out.replace(re, (_match, name, attrs) => {
            return `<${name}${attrs} style="${css}">`;
        });
    }
    return out;
}
