import path from "node:path";
import { definePlugin, type HostContext, type PluginTool } from "@getfamiliar/shared";
import { buildMemoryStore } from "./BuildStore.js";
import { buildMemoryCommands } from "./Commands.js";
import { type MemoryConfig, readMemoryConfig } from "./Config.js";
import { buildMemoryContextProvider } from "./ContextProvider.js";
import type { MemoryStore } from "./MemoryStore.js";
import { buildMemoryTools } from "./Tools.js";

/**
 * Singleton store + config handles for the host daemon process.
 * Initialized in `start`, read by `tools` and `stop`. Module scope is
 * safe because each daemon launches one host process and the manifest's
 * `tools(ctx)` hook runs after `start` resolves.
 *
 * Stays `undefined` in CLI mode (one-shot subcommands) — CLI commands
 * build their own short-lived MemoryStore via `BuildStore.ts` instead
 * of reaching for these globals.
 */
let sharedStore: MemoryStore | undefined;
let sharedConfig: MemoryConfig | undefined;

/**
 * Long-term memory plugin.
 *
 * Surfaces three integration points to the agent:
 *
 *  1. A per-agentrun **context provider** that injects relevant
 *     memories into the system prompt, keyed off the agentrun's prompt.
 *  2. A **`memory_search`** tool the agent can call to retrieve more.
 *  3. A **`memory_save`** tool that fires a `skills:memory` event
 *     whose handler (shipped here at `workspace/skills/memory/save.md`)
 *     uses a reasoning agentrun to decide where in the wiki to file
 *     the content and writes it there.
 *
 * The plugin also ships the wiki scaffold (`wiki/people/`,
 * `wiki/threads/`, `wiki/places/`) and a `skills/memory/SKILL.md`
 * explaining the wiki conventions.
 *
 * Storage backend is Orama with hybrid (vector + BM25) search,
 * persisted as a single `data/memory/memory.msp` file. Embeddings are
 * remote — provider + model identity is persisted alongside the index
 * so a config change that would invalidate vectors (different model,
 * different dimension) triggers an automatic rebuild.
 */
export default definePlugin({
    id: "memory",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    host: {
        start: async (ctx: HostContext): Promise<void> => {
            const cfg = readMemoryConfig(ctx.config);
            sharedConfig = cfg;
            const workspaceDir = path.join(ctx.dataDir, "workspace");

            let built: Awaited<ReturnType<typeof buildMemoryStore>>;
            try {
                built = await buildMemoryStore(
                    cfg,
                    (key) => ctx.inference.resolveProvider(key),
                    ctx.dataDir,
                    workspaceDir,
                    ctx.logger,
                );
            } catch (err) {
                ctx.logger.error(
                    { err: err instanceof Error ? err.message : String(err) },
                    "memory: configuration error — plugin disabled",
                );
                return;
            }
            if (!built) {
                return;
            }

            const store = built.store;
            sharedStore = store;
            await store.init();
            store.kickoffBackgroundSync(ctx.workspace);

            ctx.events.registerContextProvider(buildMemoryContextProvider(store, cfg, ctx.logger));
        },
        stop: async (): Promise<void> => {
            if (sharedStore) {
                await sharedStore.close();
                sharedStore = undefined;
            }
        },
        tools: (): readonly PluginTool[] => {
            if (!sharedStore || !sharedConfig) {
                // `tools()` runs after `start()` resolves; reaching
                // here means `start` returned early (handshake or
                // config error). Surfacing an empty tool list keeps
                // the rest of the agent functional.
                return [];
            }
            return buildMemoryTools(sharedStore, sharedConfig);
        },
        commands: (ctx: HostContext) => buildMemoryCommands(ctx),
    },
});
