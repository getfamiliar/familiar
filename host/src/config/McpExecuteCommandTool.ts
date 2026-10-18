import { existsSync, mkdirSync } from "node:fs";
import { type PluginTool, runJsonTool, ToolError } from "@getfamiliar/shared";
import { type McpCommandRunner, UnknownMcpCallError } from "../mcp/McpCommandRunner.js";
import { lintMcpConfigFile } from "../mcp/McpConfigLoader.js";
import { buildMcpOneShotDockerArgs, loadMcpEntryFromFile } from "../mcp/McpOneShot.js";
import { ensureRuntimeImage, mcpMountDirFor } from "../mcp/RuntimeImages.js";
import { CONFIG_TOOL_GROUP, type ConfigToolsDeps } from "./ConfigToolSupport.js";
import { collectConfiguredSecrets } from "./SecretOutputMasking.js";

/** Default seconds a call blocks while the command keeps running. */
const DEFAULT_WAIT_SECONDS = 20;

/** Upper bound for `waitSeconds`. */
const MAX_WAIT_SECONDS = 120;

interface McpExecuteArgs {
    readonly id?: string;
    readonly args?: readonly string[];
    readonly callId?: string;
    readonly waitSeconds?: number;
    readonly stop?: boolean;
}

/**
 * `mcp_execute_bash_command` — the agent side of `familiar tools call-mcp
 * <id> -- <args…>`: runs the MCP's container one-shot with the same
 * docker invocation as the bastion, `args` appended after the entry's
 * `args:`, and returns the output with every configured secret masked.
 * A command still running after `waitSeconds` returns its output so far
 * (e.g. a device code) and keeps running; the agent polls by `callId`.
 *
 * @param deps Shared config-tool dependencies.
 * @returns The tool.
 */
export function buildMcpExecuteCommandTool(
    deps: ConfigToolsDeps,
): PluginTool<McpExecuteArgs, object> {
    return {
        name: "mcp_execute_bash_command",
        level: "privileged",
        groups: [CONFIG_TOOL_GROUP],
        description:
            "Run a one-shot command in the runtime container of MCP `id` from config/mcp.yml, like `familiar tools call-mcp " +
            '<id> -- <args>`: same image, env, mounts and mcp.yml args, with `args` appended (e.g. ["--login"], ' +
            '["--version"]). No shell — each array item is one argument. Reads mcp.yml as on disk, so it works before ' +
            "config_reload. Returns { callId, running, exitCode, output, outputTruncated, timedOut }; `output` is stdout+stderr " +
            "new since the last read, with every configured secret replaced by ***. If the command is still running after " +
            `\`waitSeconds\` (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}), the call returns with running: true and ` +
            "the command keeps running (e.g. a device-code login waiting for the user — relay the code to the user). Then " +
            "call again with only `callId` (and optionally `waitSeconds`) for further output and the exit code, or with " +
            "`callId` + `stop: true` to kill it. Each poll counts against the tool budget, so prefer a longer waitSeconds. " +
            "Commands are killed after 15 minutes.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                id: { type: "string", description: "MCP id (start a new command)." },
                args: {
                    type: "array",
                    items: { type: "string" },
                    description: "Arguments appended after the entry's args (start a new command).",
                },
                callId: {
                    type: "string",
                    description:
                        "Id of a running command from an earlier result (poll or stop it).",
                },
                waitSeconds: {
                    type: "integer",
                    minimum: 0,
                    maximum: MAX_WAIT_SECONDS,
                    description: `Seconds to wait for the command to finish (default ${DEFAULT_WAIT_SECONDS}).`,
                },
                stop: { type: "boolean", description: "With callId: kill the command." },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const waitMs = waitSecondsOf(args.waitSeconds) * 1000;
                const runner = deps.mcpCommandRunner;
                const callId = args.callId?.trim() ?? "";
                if (callId.length > 0) {
                    if (args.id !== undefined || args.args !== undefined) {
                        throw new ToolError(
                            "InvalidArgument",
                            "pass either `id` + `args` (start a command) or `callId` (poll/stop one), not both.",
                        );
                    }
                    return continueCall(runner, callId, args.stop === true, waitMs, deps);
                }
                if (args.stop === true) {
                    throw new ToolError("InvalidArgument", "`stop` needs the `callId` to stop.");
                }
                // Collect first: a config that doesn't parse must fail before
                // the command starts, not orphan it.
                const secrets = secretsOf(deps);
                const newCallId = await startCall(args, deps);
                return runner.read(newCallId, waitMs, secrets);
            }, callCtx.toolRunContext),
    };
}

/**
 * Poll or stop a running call.
 *
 * @param runner The daemon's runner.
 * @param callId The call id.
 * @param isStop Whether to kill the call.
 * @param waitMs Maximum wait for a poll.
 * @param deps Config-tool dependencies (file paths for the secrets).
 * @returns The read result.
 * @throws ToolError `NotFound` for an unknown or expired call id.
 */
async function continueCall(
    runner: McpCommandRunner,
    callId: string,
    isStop: boolean,
    waitMs: number,
    deps: ConfigToolsDeps,
): Promise<object> {
    try {
        return isStop
            ? await runner.stop(callId, secretsOf(deps))
            : await runner.read(callId, waitMs, secretsOf(deps));
    } catch (err) {
        if (err instanceof UnknownMcpCallError) {
            throw new ToolError("NotFound", err.message);
        }
        throw err;
    }
}

/**
 * Validate the entry and start a new call.
 *
 * @param args Tool input with `id` and `args`.
 * @param deps Config-tool dependencies.
 * @returns The new call id.
 * @throws ToolError for an invalid input, an unknown/external entry or a malformed mcp.yml.
 */
async function startCall(args: McpExecuteArgs, deps: ConfigToolsDeps): Promise<string> {
    const id = args.id?.trim() ?? "";
    if (id.length === 0) {
        throw new ToolError(
            "InvalidArgument",
            "pass `id` + `args` to start a command, or `callId` to poll one.",
        );
    }
    const extraArgs = args.args ?? [];
    if (!Array.isArray(extraArgs) || extraArgs.some((a) => typeof a !== "string")) {
        throw new ToolError("InvalidArgument", "`args` must be an array of strings.");
    }
    if (!existsSync(deps.mcpConfigFile)) {
        throw new ToolError("NotFound", "config/mcp.yml does not exist; add the MCP first.");
    }
    const lint = lintMcpConfigFile(deps.mcpConfigFile);
    if (!lint.ok) {
        throw new ToolError(
            "InvalidConfig",
            `config/mcp.yml is malformed; fix it first: ${lint.errors.join("; ")}`,
        );
    }
    const entry = loadMcpEntryFromFile(deps.mcpConfigFile, id);
    if (entry === null) {
        throw new ToolError("NotFound", `unknown mcp "${id}" (not declared in config/mcp.yml).`);
    }
    if (entry.source === "external") {
        throw new ToolError(
            "InvalidArgument",
            `mcp "${id}" has source: external — there is no container to run a command in.`,
        );
    }
    const boot = deps.boot;
    if (entry.source === "npm" || entry.source === "pypi") {
        mkdirSync(mcpMountDirFor(boot.tmpDir, id), { recursive: true });
        await ensureRuntimeImage(entry.source, boot, deps.log);
    }
    const runtimeConfig = {
        tmpDir: boot.tmpDir,
        scratchDir: boot.scratchDir,
        hostUid: boot.hostUid,
        hostGid: boot.hostGid,
    };
    deps.log.info(
        `mcp_execute_bash_command: running MCP ${id} with appended args ${JSON.stringify(extraArgs)}`,
    );
    return deps.mcpCommandRunner.start(id, (containerName) =>
        buildMcpOneShotDockerArgs(entry, runtimeConfig, {
            interactive: false,
            containerName,
            appendArgs: extraArgs,
        }),
    );
}

/**
 * Clamp `waitSeconds` to `[0, MAX_WAIT_SECONDS]`.
 *
 * @param waitSeconds Requested seconds, or undefined for the default.
 * @returns The effective seconds.
 */
function waitSecondsOf(waitSeconds: number | undefined): number {
    if (typeof waitSeconds !== "number" || !Number.isFinite(waitSeconds)) {
        return DEFAULT_WAIT_SECONDS;
    }
    return Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.floor(waitSeconds)));
}

/**
 * Collect the secrets to mask, fresh from both config files.
 *
 * @param deps Config-tool dependencies.
 * @returns The secret values.
 * @throws ToolError `InvalidConfig` when a file does not parse — no output is released unmasked.
 */
function secretsOf(deps: ConfigToolsDeps): string[] {
    try {
        return collectConfiguredSecrets(deps.configFile, deps.mcpConfigFile);
    } catch (err) {
        throw new ToolError(
            "InvalidConfig",
            `${(err as Error).message} — output withheld; fix the file and poll again with the callId.`,
        );
    }
}
