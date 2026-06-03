import { parseCron } from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { bootstrap } from "../Bootstrap.js";
import { pathToHandlerTarget, readVerbatimCron } from "../cron/CronjobScheduler.js";
import { scanWorkspace } from "../workspace/WorkspaceWatcher.js";

/**
 * `cli.sh cron` — root for cronjob-related subcommands. Today only `list`
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
            async run() {
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
                printTable(rows);
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

function printTable(rows: readonly Row[]): void {
    if (rows.length === 0) {
        process.stdout.write("No handlers with `cron:` frontmatter found.\n");
        return;
    }
    const headers = ["PATH", "VERBATIM", "PARSED", "SOURCE", "STATUS"];
    const data = rows.map((r) => [r.path, r.verbatim, r.expression, r.source, r.status]);
    const widths = headers.map((h, i) => Math.max(h.length, ...data.map((row) => row[i].length)));
    const fmt = (row: readonly string[]) =>
        row
            .map((cell, i) => cell.padEnd(widths[i]))
            .join("  ")
            .trimEnd();
    process.stdout.write(`${fmt(headers)}\n`);
    for (const row of data) {
        process.stdout.write(`${fmt(row)}\n`);
    }
}
