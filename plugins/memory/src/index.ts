import path from "node:path";
import { definePlugin, type HostContext, type PluginTool } from "@getfamiliar/shared";
import { buildMemoryCommands } from "./Commands.js";
import { DEFAULT_FILE_READ_RETENTION_DAYS, readMemoryConfig } from "./Config.js";
import { renderCategoryList } from "./SearchRender.js";
import {
    buildMemoryTools,
    DEDUP_SCAN_TOPIC,
    DEDUPLICATE_TOPIC,
    DREAM_TOPIC,
    REPAIR_TOPIC,
    REVIEW_TOPIC,
    SAVE_TOPIC,
    SPLIT_TOPIC,
} from "./Tools.js";
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
 * category check is a plain cron handler (`skills/memory/categories.md`). Two more jobs hand files
 * above `memory.maxFileBytes` to `skills:memory:split` (cutting them in half when still too big)
 * and let `skills:memory:dedup-scan` find duplicate candidates per folder, each new group going to
 * `skills:memory:deduplicate`; both commit `wiki/` before and after. The dream job picks files by
 * five criteria (changed, hot — read most by `fs_read`, cold, oldest, random) and hands each to
 * `skills:memory:dream`, committing `wiki/` before and after.
 */
export default definePlugin({
    id: "memory",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    host: {
        // The maintenance cron jobs capture the time zone at start.
        restartOnConfigChange: ["core.timezone", "core.fileReadRetentionDays"],
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
                commitDirectory: (dir, message) =>
                    ctx.workspaceHistory.commitDirectory(dir, message),
                log: ctx.logger,
                lintSchedule: config.lintSchedule,
                reviewSchedule: config.reviewSchedule,
                maxFileBytes: config.maxFileBytes,
                splitSchedule: config.splitSchedule,
                dedupSchedule: config.dedupSchedule,
                dream: config.dream,
                summarizeReads: (options) => ctx.workspaceReads.summarize(options),
                readWindowDays: ctx.config.getNumber(
                    "core.fileReadRetentionDays",
                    DEFAULT_FILE_READ_RETENTION_DAYS,
                ),
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
            {
                topic: SPLIT_TOPIC,
                isExactTopic: true,
                description:
                    "A wiki file is larger than `memory.maxFileBytes` and has to be condensed or split.",
            },
            {
                topic: DEDUP_SCAN_TOPIC,
                isExactTopic: true,
                description:
                    "The weekly dedup pass hands one wiki folder's file list over to find duplicate candidates.",
            },
            {
                topic: DREAM_TOPIC,
                isExactTopic: true,
                description:
                    "The nightly dream pass picked a wiki file (changed, hot, cold, oldest or random) to revisit in the context of its cluster.",
            },
            {
                topic: DEDUPLICATE_TOPIC,
                isExactTopic: true,
                description:
                    "A group of wiki files that may be about the same subject, to be merged or told apart.",
            },
        ],
        commands: (ctx: HostContext) => buildMemoryCommands(ctx),
    },
});
