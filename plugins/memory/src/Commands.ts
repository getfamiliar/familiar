import type { HostContext } from "@getfamiliar/shared";
import { renderMarkdown } from "@getfamiliar/shared";
import { type CommandDef, defineCommand } from "citty";
import { buildMemoryStore } from "./BuildStore.js";
import { readMemoryConfig } from "./Config.js";
import { formatHitsFlat } from "./ContextProvider.js";
import type { FileSummary, MemoryStore, StoredChunk } from "./MemoryStore.js";

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
    return [searchCommand(ctx), showCommand(ctx), listCommand(ctx)];
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
                process.stdout.write(`${renderMarkdown(md)}\n`);
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
                process.stdout.write(`${renderMarkdown(renderShowReport(relPath, chunks))}\n`);
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
        args: {},
        async run() {
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
                process.stdout.write(`${renderMarkdown(renderListReport(summaries))}\n`);
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
        `${ctx.dataDir}/workspace`,
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
