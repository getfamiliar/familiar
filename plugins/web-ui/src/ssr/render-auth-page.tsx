import type { WebAuthPageView } from "@getfamiliar/shared";
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
 * @returns The HTML document.
 */
export async function renderAuthPage(view: WebAuthPageView): Promise<string> {
    const body = renderToStaticMarkup(<AuthPage view={view} />);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${TITLES[view.kind]} · Familiar</title><style>${css}</style></head><body>${body}</body></html>`;
}

/** Document titles per page (static, no escaping needed). */
const TITLES: Readonly<Record<WebAuthPageView["kind"], string>> = {
    signedIn: "Signed in",
    signedOut: "Sign in",
    confirmLoginLink: "Sign in",
    invalidLoginLink: "Sign in",
};
