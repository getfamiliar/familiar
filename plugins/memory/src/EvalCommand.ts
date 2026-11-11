import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HostContext } from "@getfamiliar/shared";
import { writeMarkdown } from "@getfamiliar/shared";
import type { ArgsDef } from "citty";
import { optionalString, RAW_ARG, warningsOnlyLogger } from "./Commands.js";
import { type AgentEvalResult, runAgentEval } from "./EvalAgent.js";
import { defaultEvalDir, EVAL_LANGUAGES, type EvalLanguage } from "./EvalCases.js";
import { buildEvalModel } from "./EvalModel.js";
import { renderEvalReport } from "./EvalReport.js";
import { DEFAULT_EVAL_SETTINGS, type MemoryEvalResult, runMemoryEval } from "./EvalRunner.js";

/**
 * Arguments of `familiar memory eval`. Lives here, not in Commands.ts, because the eval code is
 * left out of the published package; Commands.ts loads it lazily.
 */
export const EVAL_ARGS = {
    lang: {
        type: "string",
        required: false,
        description:
            "Corpus language: de, en or all (default all; all adds the en→de cross-language run).",
    },
    category: {
        type: "string",
        required: false,
        description: "Comma-separated categories to run (default all).",
    },
    case: {
        type: "string",
        required: false,
        description: "Comma-separated case id substrings to run (default all).",
    },
    threshold: {
        type: "string",
        required: false,
        description: `Word-similarity threshold (default ${DEFAULT_EVAL_SETTINGS.similarityThreshold}).`,
    },
    weights: {
        type: "string",
        required: false,
        description:
            "Field weights as title,category,description,heading,body (default 4,3,3,2,1).",
    },
    agent: {
        type: "boolean",
        required: false,
        description:
            "LLM stage: let a model formulate the searches from each case's prompt (costs model calls; replies are cached in tmp/memory-eval/agent-cache/).",
    },
    model: {
        type: "string",
        required: false,
        description:
            "Model for --agent: an inference.aliases key or <provider>/<modelId> (default fast).",
    },
    reindex: {
        type: "boolean",
        required: false,
        description: "Drop and rebuild the eval schemas first.",
    },
    misses: {
        type: "boolean",
        required: false,
        description: "List every case with a must-have file missing from the top 5.",
    },
    json: {
        type: "string",
        required: false,
        description:
            "Also write the full per-case results as JSON to this file (for diffing runs).",
    },
    dir: {
        type: "string",
        required: false,
        description: "Eval folder (default: the plugin's eval/ folder).",
    },
    raw: RAW_ARG,
} satisfies ArgsDef;

/**
 * Runs `familiar memory eval`.
 *
 * @param ctx - Host context.
 * @param args - Parsed arguments ({@link EVAL_ARGS}).
 * @returns Resolves once the report is written.
 */
// biome-ignore lint/suspicious/noExplicitAny: citty hands the parsed args over untyped here.
export async function runEvalCommand(ctx: HostContext, args: any): Promise<void> {
    const common = {
        evalDir: typeof args.dir === "string" ? path.resolve(args.dir) : defaultEvalDir(),
        languages: parseEvalLanguages(args.lang),
        categories: splitList(args.category),
        caseIdFilters: splitList(args.case),
        settings: {
            similarityThreshold:
                args.threshold === undefined
                    ? DEFAULT_EVAL_SETTINGS.similarityThreshold
                    : parseUnitInterval(args.threshold, "--threshold"),
            weights:
                args.weights === undefined
                    ? DEFAULT_EVAL_SETTINGS.weights
                    : parseWeights(args.weights),
        },
        isReindexForced: args.reindex === true,
        database: ctx.database,
        log: warningsOnlyLogger(ctx.logger),
        onProgress: (message: string) => process.stderr.write(`memory eval: ${message}\n`),
    };
    let result: MemoryEvalResult | AgentEvalResult;
    if (args.agent === true) {
        const model = await buildEvalModel(ctx, optionalString(args.model) ?? "fast");
        result = await runAgentEval({
            ...common,
            model: model.model,
            modelLabel: model.label,
            cacheDir: path.join(ctx.tmpDir, "memory-eval", "agent-cache"),
        });
    } else {
        result = await runMemoryEval(common);
    }
    if (typeof args.json === "string" && args.json.length > 0) {
        await fs.writeFile(args.json, `${JSON.stringify(result, null, 2)}\n`);
    }
    writeMarkdown(renderEvalReport(result, { isFailureListShown: args.misses === true }), {
        raw: args.raw === true,
    });
}

/**
 * Parses a number flag in (0, 1].
 *
 * @param raw - Flag value.
 * @param flag - Flag name, for the message.
 * @returns The number.
 * @throws {Error} When the value is out of range.
 */
function parseUnitInterval(raw: unknown, flag: string): number {
    const value = Number(raw);
    if (!(value > 0 && value <= 1)) {
        throw new Error(`${flag} must be a number in (0, 1], got ${String(raw)}`);
    }
    return value;
}

/**
 * Parses `--weights title,category,description,heading,body`.
 *
 * @param raw - Flag value.
 * @returns The field weights.
 * @throws {Error} When there aren't five non-negative numbers.
 */
function parseWeights(raw: unknown): (typeof DEFAULT_EVAL_SETTINGS)["weights"] {
    const values = String(raw).split(",").map(Number);
    if (values.length !== 5 || values.some((value) => !(value >= 0))) {
        throw new Error(
            `--weights must be five non-negative numbers (title,category,description,heading,body), got ${String(raw)}`,
        );
    }
    const [title, category, description, heading, body] = values;
    return { title, category, description, heading, body };
}

/**
 * Parses `--lang`.
 *
 * @param raw - Flag value.
 * @returns The selected corpus languages.
 * @throws {Error} When the value is not de, en or all.
 */
function parseEvalLanguages(raw: unknown): EvalLanguage[] {
    if (raw === undefined || raw === "all") {
        return [...EVAL_LANGUAGES];
    }
    if (raw === "de" || raw === "en") {
        return [raw];
    }
    throw new Error(`--lang must be de, en or all, got ${String(raw)}`);
}

/**
 * Splits a comma-separated flag.
 *
 * @param raw - Flag value.
 * @returns The non-empty trimmed entries (empty when the flag is absent).
 */
function splitList(raw: unknown): string[] {
    if (typeof raw !== "string") {
        return [];
    }
    return raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}
