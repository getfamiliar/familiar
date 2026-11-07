import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definePlugin, type HostContext, WebStaticAssets } from "@getfamiliar/shared";
import { buildVoiceController } from "./VoiceController.js";
import {
    CALL_SOCKET_PATH,
    GPT_VOICE_PLUGIN_ID,
    VOICE_BACKGROUND_TOPIC,
    VOICE_BRIEFING_TOPIC,
    VOICE_CALL_TOPIC,
} from "./VoiceProtocol.js";
import { VoiceService } from "./VoiceService.js";

/** The running service; set by `start`, reset by `stop`. */
let service: VoiceService | null = null;

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
            throw new Error(`gpt-voice: no package.json above ${fileURLToPath(import.meta.url)}`);
        }
        dir = parent;
    }
}

/**
 * The running service.
 *
 * @returns The service.
 * @throws {Error} Before `start` / after `stop`.
 */
function currentService(): VoiceService {
    if (service === null) {
        throw new Error("gpt-voice is not running");
    }
    return service;
}

/**
 * Start the service: subscribe to the `voice` chat channel.
 *
 * @param ctx Plugin context.
 */
async function start(ctx: HostContext): Promise<void> {
    const started = new VoiceService({
        host: {
            events: ctx.events,
            chat: ctx.chat,
            banners: ctx.banners,
            config: ctx.config,
            logger: ctx.logger,
            get assistantName() {
                return ctx.assistantName;
            },
            get timezone() {
                return ctx.config.getString(
                    "core.timezone",
                    Intl.DateTimeFormat().resolvedOptions().timeZone,
                );
            },
        },
        workspaceDir: ctx.workspaceDir,
    });
    await started.start();
    service = started;
}

/** Hang up all calls and reset module state for a restart. */
async function stop(): Promise<void> {
    const running = service;
    service = null;
    await running?.stop();
}

/**
 * Voice plugin: talk to the assistant with OpenAI's GPT-Live voice model.
 * The web UI page ("Voice") places a call over a WebSocket to the host,
 * which relays it to OpenAI with the API key (the browser never sees
 * it). Work the voice model delegates runs as `voice:background` events
 * of the normal assistant; their results are spoken. The call core is
 * transport-independent so a phone line can be added as a second
 * transport.
 */
export default definePlugin({
    id: GPT_VOICE_PLUGIN_ID,
    workspaceTemplate: path.join(findPluginRoot(), "workspace-template"),
    host: {
        start,
        stop,
        getEmittedEvents: () => [
            {
                topic: VOICE_BACKGROUND_TOPIC,
                description:
                    "The voice model delegated a task during a call; the prompt is the recent conversation, the result is spoken.",
                isExactTopic: true,
            },
            {
                topic: VOICE_BRIEFING_TOPIC,
                description:
                    "A voice call started; build a briefing (appointments, mail, tasks) the voice model gets as silent context. Reused for 30 minutes.",
                isExactTopic: true,
            },
            {
                topic: VOICE_CALL_TOPIC,
                description:
                    "Record of a voice call transcript or of a result after hang-up; created as done, no handler runs.",
                isExactTopic: true,
            },
        ],
        webMenu: () => ({
            weight: -90,
            items: [{ icon: "phone", label: "Voice", route: `/plugins/${GPT_VOICE_PLUGIN_ID}` }],
        }),
        webPlugin: (ctx) => {
            const root = findPluginRoot();
            const pageDir = path.join(root, "build", "page");
            return {
                controller: buildVoiceController(
                    currentService,
                    new WebStaticAssets(pageDir, {
                        urlPrefix: `/plugins/${GPT_VOICE_PLUGIN_ID}/page`,
                        spaFallback: false,
                        missingBuildHint: "run `npm run build` in plugins/gpt-voice",
                    }),
                ),
                page: {
                    module: "page/page.js",
                    ...(ctx.isDevMode ? { sourceFile: path.join(root, "src", "page.tsx") } : {}),
                },
                sockets: [
                    {
                        path: CALL_SOCKET_PATH,
                        onConnection: (peer, info) => currentService().onBrowserSocket(peer, info),
                    },
                ],
            };
        },
    },
});
