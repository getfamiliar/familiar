/**
 * Structural validator for the memory eval set (`cases.yml`).
 *
 * Checks that every case is well-formed and points at files that exist in the respective corpus,
 * then prints a per-category count table. Exits with code 1 when any problem is found. The
 * validation itself lives in `src/EvalCases.ts`, shared with `familiar memory eval`. Run from the
 * repo root:
 *
 * ```
 * npx tsx plugins/memory/eval/ValidateCases.ts
 * ```
 */
import * as path from "node:path";
import { markdownTable, writeMarkdown } from "@getfamiliar/shared";
import { EVAL_CATEGORIES, loadEvalCases } from "../src/EvalCases.js";

/**
 * Loads `cases.yml`, validates every case and prints the category table and any problems.
 *
 * @returns The process exit code: 0 when valid, 1 otherwise.
 * @throws {Error} When `cases.yml` cannot be read or is not valid YAML.
 */
function main(): number {
    const evalDir = path.dirname(new URL(import.meta.url).pathname);
    const { cases, problems, totalEntries } = loadEvalCases(evalDir);
    const raw = process.argv.includes("--raw");

    const rows = EVAL_CATEGORIES.map((category) => [
        category,
        String(cases.filter((evalCase) => evalCase.category === category).length),
    ]);
    rows.push(["**total**", `**${totalEntries}**`]);
    const problemSection =
        problems.length === 0
            ? "**All cases valid.**\n"
            : `**${problems.length} problem(s):**\n\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`;
    writeMarkdown(
        `# Memory eval cases\n\n${markdownTable(["Category", "Cases"], rows)}\n\n${problemSection}`,
        { raw },
    );
    return problems.length === 0 ? 0 : 1;
}

process.exitCode = main();
