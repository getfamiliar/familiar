import {
    InferenceEventBus,
    type InferenceEventRow,
    type PluginTool,
    runTextTool,
    ToolError,
} from "@getfamiliar/shared";
import type { ReflectionToolsDeps } from "../ReflectionTools.js";

interface InferenceStatusArgs {
    readonly windowMinutes?: number;
    readonly model?: string;
}

const DEFAULT_WINDOW_MINUTES = 60;
const MAX_WINDOW_MINUTES = 24 * 60;

/**
 * Build the `inference_status` reflection tool — aggregate the
 * `inference_events` audit table over the last N minutes and render
 * per-model health: total / success / retryable (429-flavored) /
 * fatal counts, status-code histogram, time since the last
 * successful call. Helps the agent answer "is my model misbehaving
 * right now, or is something else broken?".
 */
export function buildInferenceStatusTool(
    deps: ReflectionToolsDeps,
): PluginTool<InferenceStatusArgs, string> {
    return {
        name: "inference_status",
        description:
            "Per-model summary of recent upstream model calls (success / retryable / " +
            "fatal counts, status-code histogram, time since last success) over the last " +
            "`windowMinutes` (default 60, max 1440). Pass `model` to filter to one model. " +
            "Data comes from the `inference_events` table that AgentRunner writes on every " +
            "call attempt.",
        groups: ["reflection"],
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                windowMinutes: {
                    type: "integer",
                    minimum: 1,
                    maximum: MAX_WINDOW_MINUTES,
                    description: `Look-back window in minutes (default ${DEFAULT_WINDOW_MINUTES}, max ${MAX_WINDOW_MINUTES}).`,
                },
                model: {
                    type: "string",
                    description:
                        "Optional model id filter (e.g. `featherless/zai-org/GLM-5.1`). Matches " +
                        "the `model` column verbatim.",
                },
            },
        },
        execute: (args, callCtx) =>
            runTextTool(async () => {
                const windowMinutes = parseWindow(args.windowMinutes);
                const model = parseModel(args.model);

                const connection = await deps.ensureConnection();
                const bus = new InferenceEventBus(connection);
                const since = new Date(Date.now() - windowMinutes * 60 * 1000);
                const rows = await bus.listSince(since, model);
                if (rows.length === 0) {
                    return renderEmpty(windowMinutes, model);
                }

                const grouped = groupByModel(rows);
                const now = Date.now();
                const sections: string[] = [];
                sections.push(
                    `Inference status — last ${windowMinutes} minute(s)${model ? ` for \`${model}\`` : ""}, ${rows.length} call(s) total.\n`,
                );
                for (const [key, group] of grouped) {
                    sections.push(renderModelSection(key, group, now));
                }
                return sections.join("\n");
            }, callCtx.toolRunContext),
    };
}

function parseWindow(raw: unknown): number {
    if (raw === undefined || raw === null) {
        return DEFAULT_WINDOW_MINUTES;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > MAX_WINDOW_MINUTES) {
        throw new ToolError(
            "InvalidArgument",
            `windowMinutes must be an integer in [1, ${MAX_WINDOW_MINUTES}], got ${JSON.stringify(raw)}.`,
        );
    }
    return raw;
}

function parseModel(raw: unknown): string | undefined {
    if (raw === undefined || raw === null || raw === "") {
        return undefined;
    }
    if (typeof raw !== "string") {
        throw new ToolError(
            "InvalidArgument",
            `model must be a string, got ${JSON.stringify(raw)}.`,
        );
    }
    return raw;
}

function renderEmpty(windowMinutes: number, model: string | undefined): string {
    if (model !== undefined) {
        return `No inference events recorded for \`${model}\` in the last ${windowMinutes} minute(s).\n`;
    }
    return (
        `No inference events recorded in the last ${windowMinutes} minute(s). ` +
        "Either the daemon has been idle, or AgentRunner has not yet written to " +
        "the `inference_events` table.\n"
    );
}

function groupByModel(
    rows: readonly InferenceEventRow[],
): ReadonlyMap<string, readonly InferenceEventRow[]> {
    const out = new Map<string, InferenceEventRow[]>();
    for (const row of rows) {
        const key = `${row.provider}/${row.model}`;
        let arr = out.get(key);
        if (arr === undefined) {
            arr = [];
            out.set(key, arr);
        }
        arr.push(row);
    }
    return out;
}

function renderModelSection(key: string, group: readonly InferenceEventRow[], now: number): string {
    const success = group.filter((g) => g.outcome === "success");
    const retryable = group.filter((g) => g.outcome === "retryable");
    const fatal = group.filter((g) => g.outcome === "fatal");
    const lastSuccess = success[0]; // listSince orders DESC

    const lines: string[] = [];
    lines.push(`### \`${key}\``);
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("| --- | --- |");
    lines.push(`| Total calls | ${group.length} |`);
    lines.push(`| Success | ${success.length} |`);
    lines.push(`| Retryable | ${retryable.length} |`);
    lines.push(`| Fatal | ${fatal.length} |`);
    lines.push(
        `| Last success | ${lastSuccess ? `${formatAgo(now - lastSuccess.occurredAt.getTime())} ago` : "—"} |`,
    );

    const histogram = statusHistogram(group);
    if (histogram.length > 0) {
        lines.push(`| Status codes | ${histogram.join(", ")} |`);
    }
    lines.push("");
    lines.push(summarize(key, success.length, retryable.length, fatal.length, lastSuccess, now));
    lines.push("");
    return `${lines.join("\n")}\n`;
}

function statusHistogram(group: readonly InferenceEventRow[]): readonly string[] {
    const counts = new Map<number, number>();
    for (const row of group) {
        if (row.statusCode === null) {
            continue;
        }
        counts.set(row.statusCode, (counts.get(row.statusCode) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([code, n]) => `${code}: ${n}`);
}

function summarize(
    key: string,
    success: number,
    retryable: number,
    fatal: number,
    lastSuccess: InferenceEventRow | undefined,
    now: number,
): string {
    const parts: string[] = [];
    if (fatal > 0) {
        parts.push(`${fatal} fatal error(s)`);
    }
    if (retryable > 0) {
        parts.push(`${retryable} retryable error(s)`);
    }
    parts.push(`${success} success(es)`);
    const lastSuccessText = lastSuccess
        ? `last success ${formatAgo(now - lastSuccess.occurredAt.getTime())} ago`
        : "no successful calls in window";
    return `${key} — ${parts.join(", ")}; ${lastSuccessText}.`;
}

function formatAgo(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m`;
    }
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
