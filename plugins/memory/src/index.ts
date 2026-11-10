import path from "node:path";
import { definePlugin, type HostContext, type PluginTool } from "@getfamiliar/shared";
import { buildMemoryCommands } from "./Commands.js";
import { readMemoryConfig } from "./Config.js";
import { renderCategoryList } from "./SearchRender.js";
import { buildMemoryTools, REPAIR_TOPIC, REVIEW_TOPIC, SAVE_TOPIC } from "./Tools.js";
import { WikiIndexer } from "./WikiIndexer.js";
import { WikiMaintenance } from "./WikiMaintenance.js";
import { listCategories } from "./WikiSearch.js";

/**
 * The live indexer of the daemon process. Set in `start`, cleared in `stop`; stays `undefined` in
 * CLI mode, where commands open their own {@link WikiIndex} on `ctx.database`.
 */
let liveIndexer: WikiIndexer | undefined;

/** The daemon's lint and review cron jobs. Set in `start`, stopped and cleared in `stop`. */
let maintenance: WikiMaintenance | undefined;

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
 *
 * Maintenance: two cron jobs ({@link WikiMaintenance}) lint every wiki file — rewriting unambiguous
 * dates to ISO by themselves (one git commit) and handing the remaining problems to
 * `skills:memory:repair` — and hand files with a due `review_at` to `skills:memory:review`. The
 * category check is a plain cron handler (`skills/memory/categories.md`).
 */
export default definePlugin({
    id: "memory",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    host: {
        // The maintenance cron jobs capture the time zone at start.
        restartOnConfigChange: ["core.timezone"],
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
            const config = readMemoryConfig(ctx.config);
            maintenance = new WikiMaintenance({
                workspaceDir: ctx.workspaceDir,
                index: indexer.index,
                emit: (event) => ctx.events.emit(event),
                commit: (paths, message) => ctx.workspaceHistory.commitFiles(paths, message),
                log: ctx.logger,
                lintSchedule: config.lintSchedule,
                reviewSchedule: config.reviewSchedule,
                timezone: ctx.config.getString("core.timezone", "UTC") ?? "UTC",
            });
            maintenance.start();
        },
        stop: async (): Promise<void> => {
            maintenance?.stop();
            maintenance = undefined;
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
            {
                topic: REPAIR_TOPIC,
                isExactTopic: true,
                description:
                    "The nightly memory linter found a wiki file breaking the conventions (frontmatter, non-ISO dates).",
            },
            {
                topic: REVIEW_TOPIC,
                isExactTopic: true,
                description: "A wiki file's `review_at` date is due.",
            },
        ],
        commands: (ctx: HostContext) => buildMemoryCommands(ctx),
    },
});
