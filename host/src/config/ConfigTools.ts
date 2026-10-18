import { readFileSync } from "node:fs";
import { type PluginTool, runJsonTool, ToolError } from "@getfamiliar/shared";
import { parse } from "yaml";
import { diffConfigLeaves, isConfigKeyWithin } from "../reload/ConfigDiff.js";
import { RESTART_ONLY_CONFIG_KEYS, renderReloadReport } from "../reload/DaemonReloader.js";
import { removeMapEntry, setConfigValue, writeConfigAtomically } from "../utils/ConfigDocument.js";
import { lintConfigFile } from "../utils/ConfigLinter.js";
import {
    CONFIG_TOOL_GROUP,
    type ConfigToolsDeps,
    secretRefusedError,
} from "./ConfigToolSupport.js";
import { buildMcpConfigTools } from "./McpConfigTools.js";
import { isSecretConfigKey, maskSecrets } from "./SecretKeys.js";

/**
 * Build the privileged config tools: `config_get` / `config_set` /
 * `config_unset` / `config_reload` for `config.yml` and the `mcp_*`
 * tools for `mcp.yml`. Edits only change the files; `config_reload`
 * applies them to the running daemon, so several edits land together.
 *
 * Secrets never pass through these tools: reads mask them, writes
 * refuse them (see {@link isSecretConfigKey}).
 *
 * @param deps Files, live state and the reloader.
 * @returns The tools, registered by the host under `pluginId = "core"`.
 */
export function buildConfigTools(deps: ConfigToolsDeps): readonly PluginTool[] {
    return [
        buildConfigGetTool(deps),
        buildConfigSetTool(deps),
        buildConfigUnsetTool(deps),
        buildConfigReloadTool(deps),
        ...buildMcpConfigTools(deps),
    ];
}

interface ConfigGetArgs {
    readonly key?: string;
}

/** `config_get` — read `config.yml` (as on disk) with secrets masked. */
function buildConfigGetTool(deps: ConfigToolsDeps): PluginTool<ConfigGetArgs, object> {
    return {
        name: "config_get",
        level: "privileged",
        groups: [CONFIG_TOOL_GROUP],
        description:
            "Read config/config.yml as it is on disk, the whole file or the subtree at a dotted `key` " +
            '(e.g. "mail", "inference.aliases"). Secrets (any key segment containing key/token/password/secret) ' +
            'are masked: "***set***" when configured, null when empty. `pendingReload` lists keys whose file value ' +
            "differs from what the daemon currently uses (call config_reload to apply them); `restartOnly` lists keys " +
            "that only apply after a daemon restart.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                key: { type: "string", description: "Dotted path; omit for the whole file." },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const tree = readConfigTree(deps.configFile);
                const key = args.key?.trim() ?? "";
                const value = key.length === 0 ? tree : readPath(tree, key);
                const pendingReload = diffConfigLeaves(deps.config.snapshot(), tree).filter(
                    (k) =>
                        key.length === 0 || isConfigKeyWithin(k, key) || isConfigKeyWithin(key, k),
                );
                return {
                    key: key.length === 0 ? null : key,
                    value: value === undefined ? null : maskSecrets(value, key),
                    pendingReload,
                    restartOnly: RESTART_ONLY_CONFIG_KEYS,
                };
            }, callCtx.toolRunContext),
    };
}

interface ConfigSetArgs {
    readonly key?: string;
    readonly value?: unknown;
}

/** `config_set` — write one non-secret value to `config.yml`. */
function buildConfigSetTool(deps: ConfigToolsDeps): PluginTool<ConfigSetArgs, object> {
    return {
        name: "config_set",
        level: "privileged",
        groups: [CONFIG_TOOL_GROUP],
        description:
            "Set one value in config/config.yml at a dotted `key` (intermediate mappings are created, comments are kept). " +
            "`value` is any JSON value (string, number, boolean, array, object). The file is linted after the write and " +
            "restored if it became invalid. Secret keys (segments containing key/token/password/secret) are refused — " +
            "the user enters those directly. Does NOT apply the change: call config_reload after your edits.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["key", "value"],
            properties: {
                key: { type: "string", description: 'Dotted path, e.g. "mail.allowSend".' },
                value: { description: "New value (any JSON type)." },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const key = requireKey(args.key);
                if (isSecretConfigKey(key)) {
                    throw secretRefusedError(`config key ${key}`);
                }
                if (args.value === undefined) {
                    throw new ToolError(
                        "InvalidArgument",
                        "value is required (use config_unset to remove a key).",
                    );
                }
                const text = readFileSync(deps.configFile, "utf-8");
                let next: string;
                try {
                    next = setConfigValue(text, key, args.value);
                } catch (err) {
                    throw new ToolError("InvalidArgument", (err as Error).message);
                }
                writeLinted(deps.configFile, next);
                return { key, written: true, ...restartOnlyNote(key) };
            }, callCtx.toolRunContext),
    };
}

interface ConfigUnsetArgs {
    readonly key?: string;
}

/** `config_unset` — remove one key from `config.yml`. */
function buildConfigUnsetTool(deps: ConfigToolsDeps): PluginTool<ConfigUnsetArgs, object> {
    return {
        name: "config_unset",
        level: "privileged",
        groups: [CONFIG_TOOL_GROUP],
        description:
            "Remove the key at a dotted path (with its whole subtree) from config/config.yml, so the default applies. " +
            "The file is linted after the write and restored if it became invalid. Does NOT apply the change: call " +
            "config_reload after your edits.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["key"],
            properties: {
                key: { type: "string", description: 'Dotted path, e.g. "chat.compaction".' },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const key = requireKey(args.key);
                const segments = key.split(".");
                const text = readFileSync(deps.configFile, "utf-8");
                let next: string;
                try {
                    next = removeMapEntry(
                        text,
                        segments.slice(0, -1),
                        segments[segments.length - 1] as string,
                    );
                } catch (err) {
                    throw new ToolError("NotFound", (err as Error).message);
                }
                writeLinted(deps.configFile, next);
                return { key, removed: true, ...restartOnlyNote(key) };
            }, callCtx.toolRunContext),
    };
}

/** `config_reload` — apply both config files to the running daemon. */
function buildConfigReloadTool(deps: ConfigToolsDeps): PluginTool<Record<string, never>, string> {
    return {
        name: "config_reload",
        level: "privileged",
        groups: [CONFIG_TOOL_GROUP],
        description:
            "Apply the current config/config.yml and config/mcp.yml to the running daemon without a restart: validates " +
            "both files (nothing is applied on errors), swaps the config, restarts plugins whose config group changed, " +
            "starts / stops / rebuilds changed MCP servers, and updates the agent settings. Changes apply from the next " +
            "agentrun on (this run keeps its tools and settings). Returns a markdown report: applied keys, keys that " +
            "still need a daemon restart, restarted plugins, MCP changes, warnings.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        execute: async () => renderReloadReport(await deps.reloader.reload()),
    };
}

/**
 * Write `text` to the config file and lint it, restoring the previous
 * content when the result has lint errors.
 *
 * @param configFile Absolute path of `config.yml`.
 * @param text New content.
 * @throws ToolError `InvalidConfig` listing the lint errors (file restored).
 */
function writeLinted(configFile: string, text: string): void {
    try {
        writeConfigAtomically(configFile, text, () => {
            const lint = lintConfigFile(configFile);
            if (!lint.ok) {
                throw new Error(lint.errors.join("; "));
            }
        });
    } catch (err) {
        throw new ToolError(
            "InvalidConfig",
            `config.yml would become invalid, change rolled back: ${(err as Error).message}`,
        );
    }
}

/**
 * Note attached to a write result when the key only applies after a
 * daemon restart.
 *
 * @param key The written dotted path.
 * @returns `{ note }` or an empty object.
 */
function restartOnlyNote(key: string): { note?: string } {
    const isRestartOnly = RESTART_ONLY_CONFIG_KEYS.some(
        (pinned) => isConfigKeyWithin(key, pinned) || isConfigKeyWithin(pinned, key),
    );
    return isRestartOnly
        ? {
              note: `${key} only takes effect after a daemon restart (familiar stop && familiar start).`,
          }
        : {};
}

/**
 * Validate a dotted-path argument.
 *
 * @param key Raw argument.
 * @returns The trimmed key.
 * @throws ToolError `InvalidArgument` for a missing key or empty segments.
 */
function requireKey(key: string | undefined): string {
    const trimmed = key?.trim() ?? "";
    if (trimmed.length === 0 || trimmed.split(".").some((segment) => segment.length === 0)) {
        throw new ToolError(
            "InvalidArgument",
            `key must be a dotted path like "mail.allowSend" (got ${JSON.stringify(key)}).`,
        );
    }
    return trimmed;
}

/**
 * Parse `config.yml` from disk.
 *
 * @param configFile Absolute path.
 * @returns The root mapping (empty for an empty file).
 * @throws ToolError `InvalidConfig` when the file does not parse.
 */
function readConfigTree(configFile: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = parse(readFileSync(configFile, "utf-8"));
    } catch (err) {
        throw new ToolError(
            "InvalidConfig",
            `config.yml does not parse: ${(err as Error).message}`,
        );
    }
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
}

/**
 * Walk a dotted path through a parsed tree.
 *
 * @param root Parsed root.
 * @param key Dotted path.
 * @returns The value, or `undefined` when absent.
 */
function readPath(root: Record<string, unknown>, key: string): unknown {
    let cursor: unknown = root;
    for (const segment of key.split(".")) {
        if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
            return undefined;
        }
        cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
}
