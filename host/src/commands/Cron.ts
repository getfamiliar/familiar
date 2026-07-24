import { markdownTable, parseCron, writeMarkdown } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap.js";
import { pathToHandlerTarget, readVerbatimCron } from "../cron/CronjobScheduler.js";
import { scanWorkspace } from "../workspace/WorkspaceWatcher.js";

/**
 * `familiar cron` — root for cronjob-related subcommands. Today only `list`
 * is exposed; future additions (`fire`, `next`, `disable`, …) live
 * under the same root.
 */
export const cronCommand = defineCommand({
    meta: {
        name: "cron",
        description: "Inspect handler cronjobs and scheduled tasks.",
    },
    subCommands: {
        list: defineCommand({
            meta: {
                name: "list",
                description:
                    "List every handler with a `cron:` frontmatter field. Shows the verbatim expression and the parsed Croner expression.",
            },
            args: {
                raw: {
                    type: "boolean",
                    description:
                        "Skip terminal styling and emit the raw markdown verbatim. Useful for piping into a file or a markdown viewer.",
                    default: false,
                },
            },
            async run({ args }) {
                const boot = bootstrap();
                const files = await scanWorkspace(boot.workspaceDir, {
                    frontmatter: { cron: "*" },
                });
                const rows: Row[] = [];
                for (const file of files) {
                    const verbatim = readVerbatimCron(file.absolutePath) ?? "";
                    const target = pathToHandlerTarget(file.relativePath);
                    const parsed = parseCron(verbatim);
                    rows.push({
                        path: file.relativePath,
                        verbatim,
                        expression: parsed?.expression ?? "—",
                        source: parsed?.source ?? "—",
                        status: target === null ? "root" : parsed === null ? "invalid" : "ok",
                    });
                }
                rows.sort((a, b) => a.path.localeCompare(b.path));
                writeMarkdown(renderTable(rows), { raw: args.raw === true });
            },
        }),
    },
});

interface Row {
    readonly path: string;
    readonly verbatim: string;
    readonly expression: string;
    readonly source: string;
    readonly status: "ok" | "invalid" | "root";
}

/**
 * Render the cron rows as a markdown document: a GFM table, or a short
 * prose line when no handler declares a `cron:` field.
 *
 * @param rows - the collected cron handler rows
 * @returns markdown source for {@link writeMarkdown}
 */
function renderTable(rows: readonly Row[]): string {
    if (rows.length === 0) {
        return "No handlers with `cron:` frontmatter found.\n";
    }
    return markdownTable(
        ["PATH", "VERBATIM", "PARSED", "SOURCE", "STATUS"],
        rows.map((r) => [r.path, r.verbatim, r.expression, r.source, r.status]),
    );
}
