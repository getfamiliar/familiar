import path from "node:path";
import { definePlugin, type HostContext, type PluginTool } from "@getfamiliar/shared";
import { buildMemoryCommands } from "./Commands.js";
import { renderCategoryList } from "./SearchRender.js";
import { buildMemoryTools, SAVE_TOPIC } from "./Tools.js";
import { WikiIndexer } from "./WikiIndexer.js";
import { listCategories } from "./WikiSearch.js";

/**
 * The live indexer of the daemon process. Set in `start`, cleared in `stop`; stays `undefined` in
 * CLI mode, where commands open their own {@link WikiIndex} on `ctx.database`.
 */
let liveIndexer: WikiIndexer | undefined;

/**
 * Long-term memory plugin.
 *
 * Indexes every markdown file under `wiki/` into postgres (`pg_trgm` trigrams and a `simple`
 * tsvector per line, plus every ISO date) and gives the agent three tools:
 *
 *  1. **`memory_search`** — files matching any of 1–8 terms, as a markdown table. The search is
 *     literal; the agent supplies synonyms, translations and categories itself.
 *  2. **`memory_datesearch`** — every line mentioning a date in a range or on a day of the year.
 *  3. **`memory_save`** — fires a `skills:memory:save` event whose handler (shipped at
 *     `workspace/skills/memory/save.md`) files the content in the wiki.
 *
 * The `{MEMORY_CATEGORIES}` placeholder lists the categories used in the wiki's frontmatter. The
 * plugin also ships the wiki scaffold and `skills/memory/SKILL.md` with the wiki conventions.
 */
export default definePlugin({
    id: "memory",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    host: {
        prepare: (ctx: HostContext): void => {
            ctx.prompt.registerPlaceholder({
                name: "MEMORY_CATEGORIES",
                description:
                    "Categories used in the long-term memory (wiki frontmatter), with file counts.",
                provide: async () => {
                    const index = liveIndexer?.index;
                    return index
                        ? renderCategoryList(await listCategories(index))
                        : "(memory index unavailable)";
                },
            });
        },
        start: async (ctx: HostContext): Promise<void> => {
            const indexer = new WikiIndexer(ctx.database, ctx.workspaceDir, ctx.logger);
            try {
                await indexer.open();
            } catch (err) {
                ctx.logger.error(
                    `memory: cannot open the wiki index in postgres (${err instanceof Error ? err.message : String(err)}) — memory tools will fail until the plugin restarts`,
                );
                return;
            }
            liveIndexer = indexer;
            indexer.watch(ctx.workspace);
        },
        stop: async (): Promise<void> => {
            if (liveIndexer) {
                await liveIndexer.close();
                liveIndexer = undefined;
            }
        },
        tools: (ctx: HostContext): readonly PluginTool[] =>
            buildMemoryTools(ctx, () => liveIndexer?.index),
        getEmittedEvents: () => [
            {
                topic: SAVE_TOPIC,
                isExactTopic: true,
                description: "The agent called `memory_save` to file a memory in the background.",
            },
        ],
        commands: (ctx: HostContext) => buildMemoryCommands(ctx),
    },
});
