import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HostContext } from "@getfamiliar/shared";
import { type Logger, writeMarkdown } from "@getfamiliar/shared";
import { type CommandDef, defineCommand } from "citty";
import { buildMemoryStore } from "./BuildStore.js";
import { type MemoryConfig, readMemoryConfig } from "./Config.js";
import { describeErrorChain } from "./ErrorChain.js";
import { defaultEvalDir, EVAL_LANGUAGES, type EvalLanguage } from "./EvalCases.js";
import { renderEvalReport } from "./EvalReport.js";
import { runMemoryEval } from "./EvalRunner.js";
import type { FileSummary, MemoryStore, StoredChunk } from "./MemoryStore.js";
import { formatHitsFlat } from "./PromptAppender.js";

/**
 * CLI subcommands the memory plugin contributes. Both commands load
 * the persisted Orama index from disk and run an embedding query
 * against the configured provider — they do not require the daemon
 * to be running, but they will show whatever was last persisted
 * (the daemon flushes on its `persistToDiskDelay` debounce or at
 * shutdown, so recent edits may not yet be visible).
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
export function buildMemoryCommands(ctx: HostContext): readonly CommandDef<any>[] {
    return [searchCommand(ctx), showCommand(ctx), listCommand(ctx), evalCommand(ctx)];
}

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function searchCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "search",
            description:
                "Search the workspace memory index. Output mirrors what the agent sees in its system prompt.",
        },
        args: {
            raw: {
                type: "boolean",
                required: false,
                description: "Print raw markdown even on a TTY.",
            },
            query: {
                type: "positional",
                required: true,
                description: "Natural-language search query.",
            },
            k: {
                type: "string",
                required: false,
                description: "Max number of hits (default = memory.maxToolMemoryResults).",
            },
        },
        async run({ args }) {
            const cfg = readMemoryConfig(ctx.config);
            const store = await openReadOnlyStore(ctx);
            if (!store) {
                process.stderr.write(
                    "memory: embedding handshake failed — see daemon logs / config\n",
                );
                process.exitCode = 1;
                return;
            }
            const k = typeof args.k === "string" ? args.k : undefined;
            const query = typeof args.query === "string" ? args.query : "";
            const limit = parsePositiveInt(k) ?? cfg.maxToolMemoryResults;
            try {
                const hits = await store.search(query, { limit });
                const md = formatHitsFlat(hits);
                writeMarkdown(`${md}\n`, { raw: args.raw === true });
            } catch (err) {
                // The query embedding is the first real provider call of the
                // CLI run; surface the nested network cause, not just the
                // SDK's wrapper message.
                throw new Error(`memory search failed: ${describeErrorChain(err)}`, {
                    cause: err,
                });
            } finally {
                await store.close();
            }
        },
    });
}

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function showCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "show",
            description:
                "Dump every index entry recorded for a workspace-relative path. Embedding vectors are summarized as <dim>-dimension vector.",
        },
        args: {
            raw: {
                type: "boolean",
                required: false,
                description: "Print raw markdown even on a TTY.",
            },
            path: {
                type: "positional",
                required: true,
                description: "Workspace-relative markdown path (e.g. wiki/people/alice.md).",
            },
        },
        async run({ args }) {
            const store = await openReadOnlyStore(ctx);
            if (!store) {
                process.stderr.write(
                    "memory: embedding handshake failed — see daemon logs / config\n",
                );
                process.exitCode = 1;
                return;
            }
            const relPath = typeof args.path === "string" ? args.path : "";
            try {
                const chunks = store.dump(relPath);
                writeMarkdown(`${renderShowReport(relPath, chunks)}\n`, { raw: args.raw === true });
            } finally {
                await store.close();
            }
        },
    });
}

// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function listCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "list",
            description:
                "List every workspace file in the memory index, alphabetically, with chunk count and last-modified timestamp.",
        },
        args: {
            raw: {
                type: "boolean",
                required: false,
                description: "Print raw markdown even on a TTY.",
            },
        },
        async run({ args }) {
            const store = await openReadOnlyStore(ctx);
            if (!store) {
                process.stderr.write(
                    "memory: embedding handshake failed — see daemon logs / config\n",
                );
                process.exitCode = 1;
                return;
            }
            try {
                const summaries = store.listFiles();
                writeMarkdown(`${renderListReport(summaries)}\n`, { raw: args.raw === true });
            } finally {
                await store.close();
            }
        },
    });
}

/**
 * Build a read-only-style store handle for one CLI invocation. The
 * store is fully initialized (index loaded into memory) but is **not**
 * wired to the workspace watcher, so no background sync starts. The
 * caller must `close()` it to release the persist timer (no-op here
 * since we never mark dirty).
 */
async function openReadOnlyStore(ctx: HostContext): Promise<MemoryStore | null> {
    const cfg = readMemoryConfig(ctx.config);
    const built = await buildMemoryStore(
        cfg,
        (key) => ctx.inference.resolveProvider(key),
        ctx.dataDir,
        ctx.workspaceDir,
        ctx.logger,
    );
    if (!built) {
        return null;
    }
    await built.store.init();
    return built.store;
}

function renderShowReport(relativePath: string, chunks: readonly StoredChunk[]): string {
    if (chunks.length === 0) {
        return `# memory show \`${relativePath}\`\n\n(no entries indexed for this path)\n`;
    }
    const distinctMtimes = new Set(chunks.map((c) => c.lastModified));
    const headerSuffix =
        distinctMtimes.size === 1
            ? `, last modified: ${formatTimestamp(chunks[0].lastModified)}`
            : "";
    const lines: string[] = [
        `# memory show \`${relativePath}\``,
        "",
        `${chunks.length} chunk${chunks.length === 1 ? "" : "s"} stored${headerSuffix}.`,
        "",
    ];
    if (distinctMtimes.size > 1) {
        // Should never happen — every upsertFile writes one mtime
        // across every chunk for the file. Surface it if it does so a
        // partial/half-written index gets noticed.
        lines.push("**Warning:** chunks for this file have differing lastModified timestamps:");
        lines.push("");
        for (const chunk of chunks) {
            lines.push(`- "${chunk.headlines}" — ${formatTimestamp(chunk.lastModified)}`);
        }
        lines.push("");
    }
    for (const chunk of chunks) {
        lines.push(`## Path "${chunk.headlines}"`);
        lines.push("");
        lines.push(chunk.content);
        lines.push("");
    }
    return lines.join("\n");
}

function formatTimestamp(ms: number): string {
    return new Date(ms).toISOString();
}

function renderListReport(summaries: readonly FileSummary[]): string {
    if (summaries.length === 0) {
        return "# memory list\n\n(no files indexed)\n";
    }
    const totalChunks = summaries.reduce((sum, s) => sum + s.chunkCount, 0);
    const lines: string[] = [
        "# memory list",
        "",
        `${summaries.length} file${summaries.length === 1 ? "" : "s"}, ${totalChunks} chunk${totalChunks === 1 ? "" : "s"}.`,
        "",
    ];
    for (const summary of summaries) {
        const mtimes = summary.lastModifieds;
        if (mtimes.length === 1) {
            lines.push(
                `\`${summary.relativePath}\`: ${summary.chunkCount} chunk${summary.chunkCount === 1 ? "" : "s"}, ${formatTimestamp(mtimes[0])}`,
            );
            continue;
        }
        // Differing mtimes across chunks of one file — should never
        // happen in normal operation. List every distinct value so a
        // partial-update bug is visible at a glance.
        lines.push(
            `\`${summary.relativePath}\`: ${summary.chunkCount} chunk${summary.chunkCount === 1 ? "" : "s"} — **warning:** chunks have ${mtimes.length} differing lastModified timestamps:`,
        );
        for (const ms of mtimes) {
            lines.push(`  - ${formatTimestamp(ms)}`);
        }
    }
    return lines.join("\n");
}

function parsePositiveInt(raw: string | undefined): number | undefined {
    if (raw === undefined || raw === "") {
        return undefined;
    }
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
        return undefined;
    }
    return n;
}

/**
 * `familiar memory eval`: runs the eval set in `plugins/memory/eval/` against throwaway indexes
 * of its corpora (cached under `tmp/memory-eval/`) and reports ranking quality, score
 * distributions and a threshold sweep. Uses the configured `memory.*` settings; the flags
 * override single search settings for experiments.
 *
 * @param ctx - Host context (config, provider resolution, logger, tmp dir).
 * @returns The command definition.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
function evalCommand(ctx: HostContext): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "eval",
            description:
                "Run the memory search eval set (plugins/memory/eval/) and report hit@1, MRR, score distributions and a threshold sweep.",
        },
        args: {
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
            language: {
                type: "string",
                required: false,
                description: "Override memory.language (tokenizer stemmer/stopwords), e.g. german.",
            },
            "vector-weight": {
                type: "string",
                required: false,
                description:
                    "Override the hybrid vector weight (0–1); the text weight becomes 1 − value.",
            },
            "min-similarity": {
                type: "string",
                required: false,
                description: "Override memory.minVectorSimilarity (0–1).",
            },
            misses: {
                type: "boolean",
                required: false,
                description:
                    "List every case whose top file is not relevant, plus all negative cases.",
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
            raw: {
                type: "boolean",
                required: false,
                description: "Print raw markdown even on a TTY.",
            },
        },
        async run({ args }) {
            const config = applyEvalOverrides(readMemoryConfig(ctx.config), args);
            const result = await runMemoryEval({
                evalDir: typeof args.dir === "string" ? path.resolve(args.dir) : defaultEvalDir(),
                languages: parseEvalLanguages(args.lang),
                categories: splitList(args.category),
                caseIdFilters: splitList(args.case),
                config,
                cacheDir: path.join(ctx.tmpDir, "memory-eval"),
                resolveProvider: (key) => ctx.inference.resolveProvider(key),
                log: warningsOnlyLogger(ctx.logger),
                onProgress: (message) => process.stderr.write(`memory eval: ${message}\n`),
            });
            if (typeof args.json === "string" && args.json.length > 0) {
                await fs.writeFile(args.json, `${JSON.stringify(result, null, 2)}\n`);
            }
            writeMarkdown(renderEvalReport(result, { isFailureListShown: args.misses === true }), {
                raw: args.raw === true,
            });
        },
    });
}

/**
 * Applies the `memory eval` override flags to the configured memory settings.
 *
 * @param config - Memory config from config.yml.
 * @param args - Parsed CLI args.
 * @returns The effective config.
 * @throws {Error} When a numeric flag is not a number in [0, 1].
 */
function applyEvalOverrides(config: MemoryConfig, args: Record<string, unknown>): MemoryConfig {
    const vectorWeight = parseUnitInterval(args["vector-weight"], "--vector-weight");
    const minSimilarity = parseUnitInterval(args["min-similarity"], "--min-similarity");
    return {
        ...config,
        language:
            typeof args.language === "string" && args.language.length > 0
                ? args.language
                : config.language,
        hybridWeights:
            vectorWeight === undefined
                ? config.hybridWeights
                : { vector: vectorWeight, text: 1 - vectorWeight },
        minVectorSimilarity: minSimilarity ?? config.minVectorSimilarity,
    };
}

/**
 * Parses an optional numeric flag in [0, 1].
 *
 * @param raw - Raw flag value.
 * @param flag - Flag name, for the error message.
 * @returns The number, or `undefined` when the flag is absent.
 * @throws {Error} When the value is not a number in [0, 1].
 */
function parseUnitInterval(raw: unknown, flag: string): number | undefined {
    if (typeof raw !== "string" || raw === "") {
        return undefined;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`memory eval: ${flag} must be a number between 0 and 1, got "${raw}"`);
    }
    return value;
}

/**
 * Parses the `--lang` flag.
 *
 * @param raw - Raw flag value.
 * @returns The corpus languages to run.
 * @throws {Error} When the value is neither `all` nor a known language.
 */
function parseEvalLanguages(raw: unknown): EvalLanguage[] {
    if (typeof raw !== "string" || raw === "" || raw === "all") {
        return [...EVAL_LANGUAGES];
    }
    const language = EVAL_LANGUAGES.find((candidate) => candidate === raw);
    if (language === undefined) {
        throw new Error(
            `memory eval: --lang must be one of ${EVAL_LANGUAGES.join(", ")} or all, got "${raw}"`,
        );
    }
    return [language];
}

/**
 * Splits a comma-separated flag into trimmed, non-empty entries.
 *
 * @param raw - Raw flag value.
 * @returns The entries; empty when the flag is absent.
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

/**
 * Wraps a logger so only warnings and errors get through. The eval indexes ~150 files and would
 * otherwise print one info line per file into the report output.
 *
 * @param base - The logger to forward to.
 * @returns A logger that drops debug and info records.
 */
function warningsOnlyLogger(base: Logger): Logger {
    const drop = (): void => {};
    return {
        debug: drop,
        info: drop,
        warn: (objOrMessage: object | string, message?: string) =>
            typeof objOrMessage === "string"
                ? base.warn(objOrMessage)
                : base.warn(objOrMessage, message),
        error: (objOrMessage: object | string, message?: string) =>
            typeof objOrMessage === "string"
                ? base.error(objOrMessage)
                : base.error(objOrMessage, message),
        child: (bindings) => warningsOnlyLogger(base.child(bindings)),
    };
}
