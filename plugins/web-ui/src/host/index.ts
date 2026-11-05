import path from "node:path";
import { definePlugin, type HostContext } from "@getfamiliar/shared";
import { BuiltAuthPages } from "./BuiltAuthPages.js";
import { findPluginRoot } from "./PluginRoot.js";
import { StaticAssets } from "./StaticAssets.js";
import { ViteDevBridge } from "./ViteDevBridge.js";
import { type AuthPageSource, buildWebUi, type UiAssetHandler } from "./WebUiController.js";

/** Page / asset handler of the running plugin; set by `start`, reset by `stop`. */
let assets: UiAssetHandler | null = null;
/** Login-page renderer of the running plugin; set by `start`, reset by `stop`. */
let authPages: AuthPageSource | null = null;
/** The Vite dev server in dev mode, else null. */
let devBridge: ViteDevBridge | null = null;

/**
 * Pick the asset handler and login-page renderer: Vite (hot reload,
 * SSR from source) in dev mode, the built bundles from `build/client` and
 * `build/ssr` otherwise.
 *
 * @param ctx Plugin context.
 */
async function start(ctx: HostContext): Promise<void> {
    const pluginRoot = findPluginRoot();
    if (ctx.isDevMode) {
        devBridge = await ViteDevBridge.start(pluginRoot, ctx.logger);
        assets = devBridge;
        authPages = devBridge;
        return;
    }
    assets = new StaticAssets(path.join(pluginRoot, "build", "client"));
    authPages = new BuiltAuthPages(path.join(pluginRoot, "build", "ssr", "render-auth-page.js"));
}

/** Close the dev server (if any) and reset module state for a restart. */
async function stop(): Promise<void> {
    const bridge = devBridge;
    devBridge = null;
    assets = null;
    authPages = null;
    await bridge?.close();
}

/**
 * Web UI plugin: the familiar web interface (React + shadcn/ui), handed
 * to the core webserver as its root controller, plus the markup of the
 * login pages. Authentication stays in the core; this plugin only
 * renders what the core decided.
 */
export default definePlugin({
    id: "web-ui",
    host: {
        start,
        stop,
        webUi: () => {
            if (assets === null || authPages === null) {
                throw new Error("web-ui: webUi called before start");
            }
            return buildWebUi(assets, authPages);
        },
    },
});
