import { existsSync, readFileSync } from "node:fs";
import { type PluginTool, RESERVED_GROUP_NAMES, runJsonTool, ToolError } from "@getfamiliar/shared";
import { isMap, parse, parseDocument, stringify } from "yaml";
import { lintMcpConfigFile } from "../mcp/McpConfigLoader.js";
import type { McpEnvVar } from "../mcp/McpEntry.js";
import { appendEntry } from "../mcp/McpYamlAppender.js";
import { removeMapEntry, writeConfigAtomically } from "../utils/ConfigDocument.js";
import {
    CONFIG_TOOL_GROUP,
    type ConfigToolsDeps,
    secretRefusedError,
} from "./ConfigToolSupport.js";
import { buildMcpExecuteCommandTool } from "./McpExecuteCommandTool.js";
import { buildMcpRegistrySearchTool } from "./McpRegistrySearchTool.js";
import { isSecretMcpEnv, MASKED_SECRET_VALUE } from "./SecretKeys.js";

/** Same id rule the `mcp.yml` linter enforces; repeated here for an early, specific error. */
const MCP_ID_PATTERN = /^[a-z][a-z0-9]*$/;

/**
 * Build the `mcp_*` tools: `mcp_registry_search` finds servers in the
 * public registries, `mcp_execute_bash_command` runs a one-shot command
 * in an MCP's container, the others edit `config/mcp.yml`. Like the
 * `config_*` tools they only edit the file; `config_reload` applies it.
 *
 * @param deps Shared config-tool dependencies.
 * @returns `mcp_registry_search`, `mcp_list`, `mcp_add`, `mcp_remove`, `mcp_set_env`, `mcp_execute_bash_command`.
 */
export function buildMcpConfigTools(deps: ConfigToolsDeps): readonly PluginTool[] {
    return [
        buildMcpRegistrySearchTool(),
        buildMcpListTool(deps),
        buildMcpAddTool(deps),
        buildMcpRemoveTool(deps),
        buildMcpSetEnvTool(deps),
        buildMcpExecuteCommandTool(deps),
    ];
}

/** `mcp_list` — the entries in `mcp.yml`, secrets masked, with reload status. */
function buildMcpListTool(deps: ConfigToolsDeps): PluginTool<Record<string, never>, object> {
    return {
        name: "mcp_list",
        level: "privileged",
        groups: [CONFIG_TOOL_GROUP],
        description:
            "List the MCP servers in config/mcp.yml as on disk (one object per id: title, description, source, " +
            "image/package/version/url, env, args, network, gating lists). Secret env values are masked " +
            '("***set***" / null). `status` is "active" (running config), "pending-add", "pending-change" or ' +
            '"pending-remove" (file differs from the running daemon — call config_reload to apply).',
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        execute: (_args, callCtx) =>
            runJsonTool(async () => {
                const lint = lintMcpConfigFile(deps.mcpConfigFile);
                const root = readMcpTree(deps.mcpConfigFile);
                let preview = {
                    added: [] as readonly string[],
                    removed: [] as readonly string[],
                    changed: [] as readonly string[],
                };
                if (lint.ok) {
                    preview = deps.mcpRegistry.previewReload();
                }
                const servers = Object.entries(root).map(([id, raw]) => ({
                    id,
                    status: preview.added.includes(id)
                        ? "pending-add"
                        : preview.changed.includes(id)
                          ? "pending-change"
                          : "active",
                    ...maskEntry(raw),
                }));
                for (const id of preview.removed) {
                    servers.push({ id, status: "pending-remove" });
                }
                return { servers, lintErrors: lint.errors, lintWarnings: lint.warnings };
            }, callCtx.toolRunContext),
    };
}

interface McpAddArgs {
    readonly id?: string;
    readonly entry?: Record<string, unknown>;
}

/** `mcp_add` — append one complete entry to `mcp.yml`. */
function buildMcpAddTool(deps: ConfigToolsDeps): PluginTool<McpAddArgs, object> {
    return {
        name: "mcp_add",
        level: "privileged",
        groups: [CONFIG_TOOL_GROUP],
        description:
            "Add an MCP server entry to config/mcp.yml. Does not search any registry (use mcp_registry_search) — pass the complete entry. " +
            "`id`: lowercase letters/digits, starting with a letter (it becomes the tool prefix and tool group). " +
            "`entry`: { title, description, source: docker-mcp-registry|npm|pypi|external, image (docker) | " +
            "package + optional version (npm/pypi) | url (external), env?: [{name, value, is_secret?, description?}], " +
            "args?: string[], network?: {disable: boolean}, allowlist?/denylist?/approval?/privileged?: tool-name globs }. " +
            'Secret env vars (is_secret or a name containing KEY/TOKEN/PASSWORD/SECRET) must have value "" — the user ' +
            "enters them separately; the result lists them. The file is linted and restored on errors. Call config_reload " +
            "to start the server.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id", "entry"],
            properties: {
                id: { type: "string", description: 'New MCP id, e.g. "github".' },
                entry: { type: "object", description: "The entry body (see tool description)." },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const id = args.id?.trim() ?? "";
                if (!MCP_ID_PATTERN.test(id) || RESERVED_GROUP_NAMES.has(id)) {
                    throw new ToolError(
                        "InvalidArgument",
                        `id "${id}" is invalid: use lowercase letters and digits, starting with a letter, and not ${[...RESERVED_GROUP_NAMES].join("/")}.`,
                    );
                }
                if (id in readMcpTree(deps.mcpConfigFile)) {
                    throw new ToolError(
                        "AlreadyExists",
                        `mcp.yml already has an entry "${id}" (use mcp_remove first to replace it).`,
                    );
                }
                if (deps.isPluginToolGroup(id)) {
                    throw new ToolError(
                        "InvalidArgument",
                        `id "${id}" is the id of a plugin that contributes tools — "tools: ${id}" would be ambiguous; pick another id.`,
                    );
                }
                const entry = args.entry;
                if (
                    entry === undefined ||
                    entry === null ||
                    typeof entry !== "object" ||
                    Array.isArray(entry)
                ) {
                    throw new ToolError("InvalidArgument", "entry must be an object.");
                }
                const secretsToEnter: string[] = [];
                for (const env of envList(entry.env)) {
                    if (!isSecretMcpEnv(env)) {
                        continue;
                    }
                    if (typeof env.value === "string" && env.value.length > 0) {
                        throw secretRefusedError(`env ${env.name} of MCP ${id}`);
                    }
                    secretsToEnter.push(env.name);
                }
                try {
                    appendEntry(deps.mcpConfigFile, stringify({ [id]: entry }, { lineWidth: 0 }));
                } catch (err) {
                    throw new ToolError("InvalidConfig", (err as Error).message);
                }
                return {
                    id,
                    written: true,
                    secretsToEnter,
                    next:
                        secretsToEnter.length > 0
                            ? "Ask the user to enter the listed secret env values (config_ask_secret when available, or by editing config/mcp.yml), then call config_reload."
                            : "Call config_reload to start the server.",
                };
            }, callCtx.toolRunContext),
    };
}

interface McpRemoveArgs {
    readonly id?: string;
}

/** `mcp_remove` — delete one entry from `mcp.yml`. */
function buildMcpRemoveTool(deps: ConfigToolsDeps): PluginTool<McpRemoveArgs, object> {
    return {
        name: "mcp_remove",
        level: "privileged",
        groups: [CONFIG_TOOL_GROUP],
        description:
            "Remove the MCP server entry `id` from config/mcp.yml (with all its settings). Call config_reload to stop " +
            "the server and drop its tools.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: { id: { type: "string", description: "MCP id to remove." } },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const id = args.id?.trim() ?? "";
                const text = readMcpText(deps.mcpConfigFile);
                let next: string;
                try {
                    next = removeMapEntry(text, [], id);
                } catch (err) {
                    throw new ToolError(
                        "NotFound",
                        `mcp.yml has no entry "${id}": ${(err as Error).message}`,
                    );
                }
                writeLintedMcp(deps.mcpConfigFile, next);
                return { id, removed: true, next: "Call config_reload to stop the server." };
            }, callCtx.toolRunContext),
    };
}

interface McpSetEnvArgs {
    readonly id?: string;
    readonly name?: string;
    readonly value?: string;
    readonly description?: string;
}

/** `mcp_set_env` — set (or add) one non-secret env var of an entry. */
function buildMcpSetEnvTool(deps: ConfigToolsDeps): PluginTool<McpSetEnvArgs, object> {
    return {
        name: "mcp_set_env",
        level: "privileged",
        groups: [CONFIG_TOOL_GROUP],
        description:
            "Set the env var `name` of MCP `id` in config/mcp.yml to `value` (adds it when missing, with an optional " +
            "`description`). Refused for secrets (is_secret, or a name containing KEY/TOKEN/PASSWORD/SECRET) — the user " +
            "enters those directly. Call config_reload to restart the server with the new value.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id", "name", "value"],
            properties: {
                id: { type: "string", description: "MCP id." },
                name: { type: "string", description: "Env var name." },
                value: { type: "string", description: "New value." },
                description: { type: "string", description: "Description for a newly added var." },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const id = args.id?.trim() ?? "";
                const name = args.name?.trim() ?? "";
                if (name.length === 0 || typeof args.value !== "string") {
                    throw new ToolError("InvalidArgument", "name and value are required strings.");
                }
                const doc = parseDocument(readMcpText(deps.mcpConfigFile));
                const entry = doc.get(id, true);
                if (!isMap(entry)) {
                    throw new ToolError("NotFound", `mcp.yml has no entry "${id}".`);
                }
                const rawEnv: unknown = doc.toJS()?.[id]?.env;
                if (rawEnv !== undefined && !Array.isArray(rawEnv)) {
                    throw new ToolError(
                        "InvalidConfig",
                        `mcp.yml entry "${id}": env is not a list.`,
                    );
                }
                const items = rawEnv ?? [];
                const index = items.findIndex(
                    (item: unknown) => (item as { name?: unknown } | null)?.name === name,
                );
                const current = index >= 0 ? envList([items[index]])[0] : undefined;
                if (isSecretMcpEnv(current ?? { name })) {
                    throw secretRefusedError(`env ${name} of MCP ${id}`);
                }
                const added: Record<string, string> = { name, value: args.value };
                if (args.description) {
                    added.description = args.description;
                }
                if (index >= 0) {
                    doc.setIn([id, "env", index, "value"], args.value);
                } else if (rawEnv === undefined) {
                    doc.setIn([id, "env"], doc.createNode([added]));
                } else {
                    doc.addIn([id, "env"], doc.createNode(added));
                }
                writeLintedMcp(deps.mcpConfigFile, doc.toString());
                return { id, name, written: true, next: "Call config_reload to apply." };
            }, callCtx.toolRunContext),
    };
}

/**
 * Project a raw entry for the agent with secret env values masked.
 *
 * @param raw The entry as parsed from YAML.
 * @returns A copy with masked env values.
 */
function maskEntry(raw: unknown): Record<string, unknown> {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return { invalid: true };
    }
    const entry = { ...(raw as Record<string, unknown>) };
    if (Array.isArray(entry.env)) {
        entry.env = envList(entry.env).map((env) =>
            isSecretMcpEnv(env)
                ? {
                      ...env,
                      value:
                          typeof env.value === "string" && env.value.length > 0
                              ? MASKED_SECRET_VALUE
                              : null,
                  }
                : env,
        );
    }
    return entry;
}

/**
 * Coerce an `env` value to its well-formed items.
 *
 * @param raw The raw `env` value.
 * @returns Items with a string `name`.
 */
function envList(raw: unknown): (Partial<McpEnvVar> & { readonly name: string })[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter(
        (item): item is Partial<McpEnvVar> & { name: string } =>
            item !== null &&
            typeof item === "object" &&
            typeof (item as { name?: unknown }).name === "string",
    );
}

/**
 * Read `mcp.yml` text; a missing file reads as empty.
 *
 * @param mcpConfigFile Absolute path.
 * @returns The file content.
 */
function readMcpText(mcpConfigFile: string): string {
    return existsSync(mcpConfigFile) ? readFileSync(mcpConfigFile, "utf-8") : "";
}

/**
 * Parse `mcp.yml` into its root mapping.
 *
 * @param mcpConfigFile Absolute path.
 * @returns The root mapping (empty when missing or empty).
 * @throws ToolError `InvalidConfig` when the file does not parse.
 */
function readMcpTree(mcpConfigFile: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = parse(readMcpText(mcpConfigFile));
    } catch (err) {
        throw new ToolError("InvalidConfig", `mcp.yml does not parse: ${(err as Error).message}`);
    }
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
}

/**
 * Write `mcp.yml` and lint it, restoring the previous content on errors.
 *
 * @param mcpConfigFile Absolute path.
 * @param text New content.
 * @throws ToolError `InvalidConfig` listing the lint errors (file restored).
 */
function writeLintedMcp(mcpConfigFile: string, text: string): void {
    try {
        writeConfigAtomically(mcpConfigFile, text, () => {
            const lint = lintMcpConfigFile(mcpConfigFile);
            if (!lint.ok) {
                throw new Error(lint.errors.join("; "));
            }
        });
    } catch (err) {
        throw new ToolError(
            "InvalidConfig",
            `mcp.yml would become invalid, change rolled back: ${(err as Error).message}`,
        );
    }
}
