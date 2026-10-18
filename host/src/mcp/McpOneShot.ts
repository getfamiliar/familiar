import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { DockerArgsOptions, RuntimeContainerConfig } from "./factories/DockerArgsOptions.js";
import { buildDockerRegistryArgs } from "./factories/DockerMcpRegistryFactory.js";
import { buildNpmDockerArgs } from "./factories/NpmFactory.js";
import { buildPypiDockerArgs } from "./factories/PypiFactory.js";
import {
    DEFAULT_IDLE_TIMEOUT_SECONDS,
    type McpEntry,
    type McpEnvVar,
    type McpNetwork,
    type McpSource,
} from "./McpEntry.js";

/**
 * Pull a single entry from `mcp.yml` by id, reading the file as on
 * disk (not the daemon's live registry), so a freshly added entry can
 * be called before `config reload`. Mirrors the projection `McpList.ts`
 * does: parse the YAML, walk to the named key, shape the fields we need
 * without going through the logger-requiring `loadMcpEntries` path.
 * Callers lint the file first.
 *
 * @param filePath Absolute path of `mcp.yml`.
 * @param id MCP id.
 * @returns The entry, or `null` when the id is not declared.
 */
export function loadMcpEntryFromFile(filePath: string, id: string): McpEntry | null {
    const raw = readFileSync(filePath, "utf-8");
    const root = parse(raw);
    if (root === null || root === undefined || typeof root !== "object" || Array.isArray(root)) {
        return null;
    }
    const value = (root as Record<string, unknown>)[id];
    if (
        value === undefined ||
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value)
    ) {
        return null;
    }
    const e = value as Record<string, unknown>;
    const network: McpNetwork = {
        disable: Boolean((e.network as Record<string, unknown> | undefined)?.disable ?? false),
    };
    return {
        id,
        title: (e.title as string) ?? id,
        description: (e.description as string) ?? "",
        source: e.source as McpSource,
        env: ((e.env as McpEnvVar[] | undefined) ?? []).map((env) => ({
            name: env.name,
            value: env.value,
            is_secret: env.is_secret,
            example: env.example,
            description: env.description,
        })),
        volumes: (e.volumes as string[] | undefined) ?? [],
        args: (e.args as string[] | undefined) ?? [],
        command: typeof e.command === "string" ? e.command : null,
        network,
        allowlist: (e.allowlist as string[] | undefined) ?? [],
        denylist: (e.denylist as string[] | undefined) ?? [],
        approval: (e.approval as string[] | undefined) ?? [],
        privileged: (e.privileged as string[] | undefined) ?? [],
        image: typeof e.image === "string" ? e.image : undefined,
        package: typeof e.package === "string" ? e.package : undefined,
        version: typeof e.version === "string" ? e.version : undefined,
        url: typeof e.url === "string" ? e.url : undefined,
        idleTimeoutSeconds:
            typeof e.idleTimeoutSeconds === "number"
                ? e.idleTimeoutSeconds
                : DEFAULT_IDLE_TIMEOUT_SECONDS,
    };
}

/**
 * Build the one-shot `docker run` argv for a container-backed entry —
 * the same invocation the bastion builds, tweaked by `options` (TTY,
 * container name, appended args).
 *
 * @param entry The entry; must not be `source: external`.
 * @param runtimeConfig Host paths and uid/gid for the run.
 * @param options One-shot knobs.
 * @returns The docker argv (without the leading `docker`).
 * @throws Error when the entry is `source: external` or lacks its package/image.
 */
export function buildMcpOneShotDockerArgs(
    entry: McpEntry,
    runtimeConfig: RuntimeContainerConfig,
    options: DockerArgsOptions,
): string[] {
    if (entry.source === "npm") {
        return buildNpmDockerArgs(entry, runtimeConfig, options);
    }
    if (entry.source === "pypi") {
        return buildPypiDockerArgs(entry, runtimeConfig, options);
    }
    if (entry.source === "external") {
        throw new Error(`MCP "${entry.id}" has source: external — there is no container to run.`);
    }
    return buildDockerRegistryArgs(entry, runtimeConfig, options);
}
