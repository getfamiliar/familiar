/**
 * Global at-rules that must stay at the top level of a stylesheet (they
 * are not allowed inside `@scope`, and are harmless globally: Tailwind's
 * `@property` registrations, keyframes, fonts, the layer order).
 */
const TOP_LEVEL_RULES = [
    "CSSPropertyRule",
    "CSSKeyframesRule",
    "CSSFontFaceRule",
    "CSSLayerStatementRule",
    "CSSImportRule",
];

/**
 * Confine a stylesheet to the elements below `scopeSelector` with
 * `@scope`. The web UI and the page each bring their own Tailwind build;
 * unscoped, the page's utilities (injected later) would override the web
 * UI's responsive variants (e.g. `.hidden` beating `md:block` in the
 * sidebar). Scoped, the page's rules apply only inside the page — and win
 * there, by scope proximity.
 *
 * Must run in a browser (parses with CSSOM).
 *
 * @param css Stylesheet text.
 * @param scopeSelector Selector of the page container.
 * @returns The scoped stylesheet text.
 */
export function scopeStylesheet(css: string, scopeSelector: string): string {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const topLevel: string[] = [];
    const scoped: string[] = [];
    for (const rule of sheet.cssRules) {
        if (TOP_LEVEL_RULES.includes(rule.constructor.name)) {
            topLevel.push(rule.cssText);
        } else if (rule instanceof CSSLayerBlockRule && rule.name === "theme") {
            // Tailwind's theme variables (spacing, containers, fonts) sit on
            // `:root, :host`, which never match inside a scope: put them on
            // the scope root. The shadcn color tokens (`:root` / `.dark`
            // outside the layer) stay as they are and are inherited from the
            // web UI, so its light / dark switch applies to the page too.
            scoped.push(rule.cssText.replace(/:root|:host/g, ":scope"));
        } else {
            scoped.push(rule.cssText);
        }
    }
    return `${topLevel.join("\n")}\n@scope (${scopeSelector}) {\n${scoped.join("\n")}\n}`;
}
