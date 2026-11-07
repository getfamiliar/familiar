import { avatarToDataUrl } from "@getfamiliar/avatar";
import type { WebAssistantIdentity, WebAuthPageView } from "@getfamiliar/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthPage } from "@/components/auth-page";
import css from "../index.css?inline";

/**
 * Render a login-flow page as a complete, self-contained HTML document:
 * static markup without scripts, the app's CSS inlined (fonts as `data:`
 * URIs in the production build), so it works under the core webserver's
 * strict Content-Security-Policy for these pages.
 *
 * Built with `vite build --ssr` into `build/ssr/`; in dev mode the
 * plugin loads this module through Vite's `ssrLoadModule`, so edits
 * show up on the next page load.
 *
 * @param view The page the core decided to show.
 * @param assistant The assistant's name and avatar for title, favicon and brand panel.
 * @returns The HTML document.
 */
export async function renderAuthPage(
    view: WebAuthPageView,
    assistant: WebAssistantIdentity,
): Promise<string> {
    const body = renderToStaticMarkup(<AuthPage view={view} assistant={assistant} />);
    // The data URL is percent-encoded, so it cannot break out of the attribute.
    const favicon = avatarToDataUrl(assistant.avatar);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${TITLES[view.kind]} · ${escapeHtml(assistant.name)}</title><link rel="icon" type="image/svg+xml" href="${favicon}" /><style>${css}</style></head><body>${body}</body></html>`;
}

/** Document titles per page (static, no escaping needed). */
const TITLES: Readonly<Record<WebAuthPageView["kind"], string>> = {
    signedIn: "Signed in",
    signedOut: "Sign in",
    confirmLoginLink: "Sign in",
    invalidLoginLink: "Sign in",
};

/**
 * Escape text for an HTML text node (the `<title>`; the body is escaped
 * by React).
 *
 * @param text Raw text.
 * @returns The escaped text.
 */
function escapeHtml(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
