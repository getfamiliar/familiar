import path from "node:path";
import { definePlugin, type HostContext } from "@getfamiliar/shared";
import { findPluginRoot } from "./PluginRoot.js";
import { StaticAssets } from "./StaticAssets.js";
import { ViteDevBridge } from "./ViteDevBridge.js";
import { buildWebUiController, type UiAssetHandler } from "./WebUiController.js";

/** Page / asset handler of the running plugin; set by `start`, reset by `stop`. */
let assets: UiAssetHandler | null = null;
/** The Vite dev server in dev mode, else null. */
let devBridge: ViteDevBridge | null = null;

/**
 * Pick the asset handler: Vite with hot reload in dev mode, the built
 * bundle from `build/client` otherwise.
 *
 * @param ctx Plugin context.
 */
async function start(ctx: HostContext): Promise<void> {
    const pluginRoot = findPluginRoot();
    if (ctx.isDevMode) {
        devBridge = await ViteDevBridge.start(pluginRoot, ctx.logger);
        assets = devBridge;
        return;
    }
    assets = new StaticAssets(path.join(pluginRoot, "build", "client"));
}

/** Close the dev server (if any) and reset module state for a restart. */
async function stop(): Promise<void> {
    const bridge = devBridge;
    devBridge = null;
    assets = null;
    await bridge?.close();
}

/**
 * Web UI plugin: the familiar web interface (React + shadcn/ui), handed
 * to the core webserver as its root controller. Authentication stays in
 * the core; this plugin only renders for the signed-in user.
 */
export default definePlugin({
    id: "web-ui",
    host: {
        start,
        stop,
        webUi: () => {
            if (assets === null) {
                throw new Error("web-ui: webUi called before start");
            }
            return buildWebUiController(assets);
        },
    },
});
