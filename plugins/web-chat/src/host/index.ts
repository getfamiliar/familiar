import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    DEFAULT_WRITABLE_PATHS,
    definePlugin,
    HandlerCatalog,
    type HostContext,
    WebStaticAssets,
} from "@getfamiliar/shared";
import { buildChatController } from "./ChatController.js";
import { ChatHub } from "./ChatHub.js";
import { WEB_CHAT_TOPIC } from "./ChatProtocol.js";

/** The running hub; set by `start`, reset by `stop`. */
let hub: ChatHub | null = null;

/**
 * Directory of this plugin's package, found by walking up from this
 * module (works from `build/` and from `src/host/`).
 *
 * @returns Absolute path of the plugin root.
 * @throws {Error} When no `package.json` is found.
 */
function findPluginRoot(): string {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
        if (existsSync(path.join(dir, "package.json"))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(`web-chat: no package.json above ${fileURLToPath(import.meta.url)}`);
        }
        dir = parent;
    }
}

/**
 * The running hub.
 *
 * @returns The hub.
 * @throws {Error} Before `start` / after `stop`.
 */
function currentHub(): ChatHub {
    if (hub === null) {
        throw new Error("web-chat is not running");
    }
    return hub;
}

/**
 * Start the hub: subscribe to the `web` chat channel.
 *
 * @param ctx Plugin context.
 */
async function start(ctx: HostContext): Promise<void> {
    const writablePaths = ctx.config.getStringList("core.writablePaths", DEFAULT_WRITABLE_PATHS);
    const started = new ChatHub({
        chat: ctx.chat,
        events: ctx.events,
        handlers: new HandlerCatalog(ctx.workspaceDir, writablePaths),
        log: ctx.logger,
    });
    await started.start();
    hub = started;
}

/** Stop the hub and reset module state for a restart. */
async function stop(): Promise<void> {
    const running = hub;
    hub = null;
    await running?.stop();
}

/**
 * Web chat plugin: chat with the assistant in the web UI, on the chat
 * channel `web`. Provides the API (history, send, handler list, live
 * events via SSE), the chat page module and the menu entry; feature
 * parity with cli-chat (direct handler calls, live progress, proactive
 * messages, failure messages).
 */
export default definePlugin({
    id: "web-chat",
    workspaceTemplate: path.join(findPluginRoot(), "workspace-template"),
    host: {
        start,
        stop,
        getEmittedEvents: () => [
            { topic: WEB_CHAT_TOPIC, description: "The user sent a chat message in the web UI." },
        ],
        webMenu: () => ({
            weight: -100,
            items: [{ icon: "message-circle", label: "Chat", route: "/plugins/web-chat" }],
        }),
        webPlugin: (ctx) => {
            const root = findPluginRoot();
            const pageDir = path.join(root, "build", "page");
            return {
                controller: buildChatController(
                    currentHub,
                    new WebStaticAssets(pageDir, {
                        urlPrefix: "/plugins/web-chat/page",
                        spaFallback: false,
                        missingBuildHint: "run `npm run build` in plugins/web-chat",
                    }),
                ),
                page: {
                    module: "page/page.js",
                    ...(ctx.isDevMode ? { sourceFile: path.join(root, "src", "page.tsx") } : {}),
                },
            };
        },
    },
});
