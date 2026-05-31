import { exec as execCb } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { type PluginTool, runTextTool } from "@getfamiliar/shared";
import type { ReflectionToolsDeps } from "../ReflectionTools.js";

const exec = promisify(execCb);
const DF_TIMEOUT_MS = 1500;

/**
 * Build the `system_status` reflection tool — a one-shot snapshot of
 * the host the daemon runs on: OS, CPU, memory, load average, daemon
 * uptime, and `df` for the two paths the daemon depends on (data dir
 * and scratch dir). Single markdown table. Useful when "is the
 * machine wedged?" is part of debugging.
 */
export function buildSystemStatusTool(
    deps: ReflectionToolsDeps,
): PluginTool<Record<string, never>, string> {
    return {
        name: "system_status",
        description:
            "Snapshot of the daemon host: OS / kernel / arch, CPU model + count + load " +
            "average, memory totals, daemon uptime, and disk usage for the data and " +
            "scratch directories. Returned as a single markdown table.",
        groups: ["reflection"],
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
        },
        execute: (_args, callCtx) =>
            runTextTool(async () => {
                const cpus = os.cpus();
                const load = os.loadavg();
                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                const memUsage = process.memoryUsage();
                const uptime = process.uptime();

                const lines: string[] = [];
                lines.push("| Metric | Value |");
                lines.push("| --- | --- |");
                lines.push(`| OS | ${os.type()} ${os.release()} (${os.platform()}) |`);
                lines.push(`| Arch | ${os.arch()} |`);
                lines.push(`| CPU | ${cpus[0]?.model ?? "unknown"} × ${cpus.length} core(s) |`);
                lines.push(
                    `| Load avg (1/5/15) | ${load[0].toFixed(2)} / ${load[1].toFixed(2)} / ${load[2].toFixed(2)} |`,
                );
                lines.push(
                    `| Memory | ${formatBytes(totalMem - freeMem)} used / ${formatBytes(totalMem)} total (${formatPct((totalMem - freeMem) / totalMem)}) |`,
                );
                lines.push(`| Free memory | ${formatBytes(freeMem)} |`);
                lines.push(`| Daemon RSS | ${formatBytes(memUsage.rss)} |`);
                lines.push(
                    `| Daemon heap | ${formatBytes(memUsage.heapUsed)} used / ${formatBytes(memUsage.heapTotal)} total |`,
                );
                lines.push(`| Daemon uptime | ${formatDuration(uptime)} |`);
                lines.push(`| Hostname | ${os.hostname()} |`);

                const dfRows = await collectDf([deps.logsDir, deps.scratchDir]);
                for (const row of dfRows) {
                    lines.push(`| Disk \`${row.path}\` | ${row.summary} |`);
                }

                return `${lines.join("\n")}\n`;
            }, callCtx.toolRunContext),
    };
}

interface DfRow {
    readonly path: string;
    readonly summary: string;
}

async function collectDf(paths: readonly string[]): Promise<readonly DfRow[]> {
    const out: DfRow[] = [];
    for (const p of paths) {
        out.push({ path: p, summary: await readDf(p) });
    }
    return out;
}

async function readDf(target: string): Promise<string> {
    try {
        const { stdout } = await exec(`df -P ${JSON.stringify(target)}`, {
            timeout: DF_TIMEOUT_MS,
        });
        // Skip header, take line 2; columns: Filesystem 1024-blocks Used
        // Available Capacity Mounted-on.
        const dataLine = stdout.split("\n")[1];
        if (dataLine === undefined) {
            return "df returned no rows";
        }
        const cols = dataLine.split(/\s+/).filter((c) => c.length > 0);
        if (cols.length < 5) {
            return `df output malformed: ${dataLine}`;
        }
        const usedKb = Number.parseInt(cols[2], 10);
        const availKb = Number.parseInt(cols[3], 10);
        const capacity = cols[4];
        if (!Number.isFinite(usedKb) || !Number.isFinite(availKb)) {
            return `df numbers unparseable: ${dataLine}`;
        }
        return `${formatBytes(usedKb * 1024)} used / ${formatBytes(availKb * 1024)} available (${capacity})`;
    } catch (err) {
        return `df unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    }
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function formatPct(ratio: number): string {
    return `${Math.round(ratio * 100)}%`;
}

function formatDuration(seconds: number): string {
    if (seconds < 60) {
        return `${seconds.toFixed(0)}s`;
    }
    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    }
    if (seconds < 86400) {
        return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    }
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return `${days}d ${hours}h`;
}
