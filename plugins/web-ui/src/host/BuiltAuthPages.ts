import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { WebAuthPageView } from "@getfamiliar/shared";

/** Signature of `renderAuthPage` exported by the SSR bundle. */
export type RenderAuthPage = (view: WebAuthPageView, assistantName: string) => Promise<string>;

/**
 * The production login-page renderer: the SSR bundle
 * (`build/ssr/render-auth-page.js`, built by `vite build --ssr`),
 * imported once on first use.
 */
export class BuiltAuthPages {
    private readonly bundleFile: string;
    private loaded: Promise<RenderAuthPage> | null = null;

    /**
     * @param bundleFile Absolute path of the SSR bundle.
     */
    constructor(bundleFile: string) {
        this.bundleFile = bundleFile;
    }

    /**
     * Render one page.
     *
     * @param view The page the core decided to show.
     * @param assistantName The assistant's name for title and brand panel.
     * @returns The HTML document.
     * @throws {Error} When the bundle is missing or does not export
     *   `renderAuthPage` (the core then serves its plain page).
     */
    async renderAuthPage(view: WebAuthPageView, assistantName: string): Promise<string> {
        this.loaded ??= this.load();
        const render = await this.loaded.catch((err: unknown) => {
            // Retry on the next request (e.g. after `npm run build`).
            this.loaded = null;
            throw err;
        });
        return render(view, assistantName);
    }

    /**
     * Import the bundle.
     *
     * @returns Its `renderAuthPage` export.
     * @throws {Error} When the file is missing or lacks the export.
     */
    private async load(): Promise<RenderAuthPage> {
        if (!existsSync(this.bundleFile)) {
            throw new Error(
                `web-ui: the login-page bundle is missing (${this.bundleFile}) — run \`npm run build\` in plugins/web-ui`,
            );
        }
        const module = (await import(pathToFileURL(this.bundleFile).href)) as {
            renderAuthPage?: unknown;
        };
        if (typeof module.renderAuthPage !== "function") {
            throw new Error(`web-ui: ${this.bundleFile} does not export renderAuthPage`);
        }
        return module.renderAuthPage as RenderAuthPage;
    }
}
