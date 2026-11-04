import { readFileSync } from "node:fs";
import type { Logger } from "@getfamiliar/shared";
import { parse } from "yaml";
import { lintMcpConfigFile } from "../mcp/McpConfigLoader.js";
import type { McpGateway } from "../mcp/McpGateway.js";
import type { McpDiff, McpRegistry } from "../mcp/McpRegistry.js";
import { validateConfiguredProviders } from "../models/ProviderResolution.js";
import type { PluginHost, PluginReloadReport } from "../plugins/PluginHost.js";
import type { PluginToolsRegistry } from "../plugins/ToolsRegistry.js";
import { lintStorageStatic } from "../storage/StorageConfig.js";
import { lintConfigFile } from "../utils/ConfigLinter.js";
import type { HostConfigService } from "../utils/ConfigService.js";
import { diffConfigLeaves, isConfigKeyOverlapping } from "./ConfigDiff.js";

/**
 * `config.yml` keys the running daemon cannot apply: they are baked into
 * the postgres cluster, the bastion, the agent image, the container's
 * root entrypoint or the log streams at boot. A reload keeps their old
 * value in effect (pinned in the {@link HostConfigService}) and reports
 * them as "restart required".
 */
export const RESTART_ONLY_CONFIG_KEYS: readonly string[] = [
    "core.postgresPassword",
    "core.bastionToken",
    "core.writablePaths",
    "core.logRetentionDays",
    "python.packages",
];

/** Dependencies of the {@link DaemonReloader}; all owned by the daemon `start` command. */
export interface DaemonReloaderDeps {
    /** Absolute path of `config/config.yml`. */
    readonly configFile: string;
    /** Absolute path of `config/mcp.yml`. */
    readonly mcpConfigFile: string;
    /** The daemon's config service, swapped in place by the reload. */
    readonly config: HostConfigService;
    /** Plugin lifecycle owner (plugin restarts, provider metadata, storage). */
    readonly pluginHost: PluginHost;
    /** Plugin tools registry, for MCP-id vs plugin-id clash checks. */
    readonly toolsRegistry: PluginToolsRegistry;
    /** Parsed `mcp.yml`. */
    readonly mcpRegistry: McpRegistry;
    /** MCP gateway whose transports follow the registry. */
    readonly mcpGateway: McpGateway;
    /**
     * Re-resolve the inference providers from the (already reloaded)
     * config and swap the reverse proxy's provider table.
     */
    readonly applyInference: () => Promise<void>;
    /**
     * Restart the user-facing webserver with the (already reloaded)
     * `webserver.*` settings. Called only when a `webserver` key changed.
     */
    readonly applyWebServer: () => Promise<void>;
    /**
     * Rebuild the agent container's passed config from the reloaded
     * config and publish it for the container's next agentrun.
     */
    readonly publishContainerConfig: () => Promise<void>;
    /** Logger child for reload lines. */
    readonly log: Logger;
}

/** Outcome of one {@link DaemonReloader.reload}. */
export interface ReloadReport {
    /**
     * Validation errors. Non-empty means nothing was applied — the
     * daemon keeps running on the previous configuration.
     */
    readonly errors: readonly string[];
    /** Problems after the commit point (partially applied) and advisory findings. */
    readonly warnings: readonly string[];
    /** `config.yml` keys that changed and are in effect now. */
    readonly appliedKeys: readonly string[];
    /** `config.yml` keys that changed but only take effect after a daemon restart. */
    readonly restartRequiredKeys: readonly string[];
    /** What the `mcp.yml` reload changed. */
    readonly mcp: McpDiff;
    /** Plugin restarts triggered by the config change. */
    readonly plugins: PluginReloadReport;
}

/** An empty MCP diff. */
const NO_MCP_CHANGES: McpDiff = { added: [], removed: [], changed: [] };

/** An empty plugin report. */
const NO_PLUGIN_CHANGES: PluginReloadReport = { restarted: [], failed: [], needsDaemonRestart: [] };

/**
 * Applies edits of `config/config.yml` and `config/mcp.yml` to the running
 * daemon — the replacement for "restart the daemon" after a config change.
 * Triggered explicitly (agent tool `config_reload`, `familiar config
 * reload`), never by a file watcher, so a half-edited file is never applied.
 *
 * A reload first validates both files completely (structure, provider
 * resolution, MCP ids) and aborts without touching anything when that
 * fails. Then it commits:
 *
 * 1. swaps the config state (restart-only keys stay pinned) — every
 *    per-use reader (mail / calendar safety, storage, chat compaction, …)
 *    sees the new values from here on;
 * 2. rebuilds the reverse proxy's provider table;
 * 3. restarts the plugins whose config group changed;
 * 4. applies the `mcp.yml` diff to the gateway and drops stale plugin
 *    MCP sessions;
 * 5. publishes the rebuilt container config (applies from the next
 *    agentrun on; the container's MCP pool resyncs per run as well).
 *
 * Reloads are serialized; a concurrent call waits for the running one.
 */
export class DaemonReloader {
    private readonly deps: DaemonReloaderDeps;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(deps: DaemonReloaderDeps) {
        this.deps = deps;
    }

    /**
     * Validate and apply both config files.
     *
     * @returns What changed, what needs a restart, and any errors.
     */
    reload(): Promise<ReloadReport> {
        const run = this.queue.then(() => this.reloadNow());
        this.queue = run.catch(() => undefined);
        return run;
    }

    /** Worker for {@link reload}; runs with the queue held. */
    private async reloadNow(): Promise<ReloadReport> {
        const { deps } = this;
        const errors = await this.validate();
        if (errors.length > 0) {
            deps.log.warn(
                `config reload aborted, nothing applied: ${errors.length} error(s): ${errors.join("; ")}`,
            );
            return {
                errors,
                warnings: [],
                appliedKeys: [],
                restartRequiredKeys: [],
                mcp: NO_MCP_CHANGES,
                plugins: NO_PLUGIN_CHANGES,
            };
        }

        const warnings: string[] = [];
        const { previous } = deps.config.reload(RESTART_ONLY_CONFIG_KEYS);
        const changedKeys = diffConfigLeaves(previous, readConfigTree(deps.configFile));
        const restartRequiredKeys = changedKeys.filter((key) =>
            RESTART_ONLY_CONFIG_KEYS.some((pinned) => isConfigKeyOverlapping(key, pinned)),
        );
        const appliedKeys = changedKeys.filter((key) => !restartRequiredKeys.includes(key));

        await this.step("inference providers", warnings, () => deps.applyInference());
        if (appliedKeys.some((key) => isConfigKeyOverlapping(key, "storage"))) {
            deps.pluginHost.storage.resetCaches();
        }
        let plugins = NO_PLUGIN_CHANGES;
        await this.step("plugin restarts", warnings, async () => {
            plugins = await deps.pluginHost.reloadPluginsForConfigChange(appliedKeys);
        });
        let mcp = NO_MCP_CHANGES;
        await this.step("mcp.yml", warnings, async () => {
            mcp = deps.mcpRegistry.reload();
            await deps.mcpGateway.applyDiff(mcp);
            await deps.pluginHost.mcp.invalidate([...mcp.removed, ...mcp.changed]);
        });
        if (appliedKeys.some((key) => isConfigKeyOverlapping(key, "webserver"))) {
            await this.step("webserver", warnings, () => deps.applyWebServer());
        }
        await this.step("container config", warnings, () => deps.publishContainerConfig());
        warnings.push(...this.lintStorageAgainstProviders());

        deps.log.info(
            `config reloaded: applied [${appliedKeys.join(", ")}], restart required [${restartRequiredKeys.join(", ")}], ` +
                `plugins restarted [${plugins.restarted.join(", ")}], mcp added [${mcp.added.join(", ")}] removed [${mcp.removed.join(", ")}] changed [${mcp.changed.join(", ")}]`,
        );
        return { errors: [], warnings, appliedKeys, restartRequiredKeys, mcp, plugins };
    }

    /**
     * Run one commit step; a throw is logged and recorded as a warning
     * (the reload is past its commit point, so the remaining steps
     * still run).
     *
     * @param label Step name for the message.
     * @param warnings Collector for the failure message.
     * @param body The step.
     */
    private async step(
        label: string,
        warnings: string[],
        body: () => Promise<void>,
    ): Promise<void> {
        try {
            await body();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            warnings.push(`${label}: not applied — ${message}`);
            this.deps.log.error(`config reload step "${label}" failed: ${message}`);
        }
    }

    /**
     * Validate both files without applying anything.
     *
     * @returns Error messages; empty when the reload may proceed.
     */
    private async validate(): Promise<string[]> {
        const { deps } = this;
        const errors: string[] = [];
        const lint = lintConfigFile(deps.configFile);
        errors.push(...lint.errors.map((e) => `config.yml: ${e}`));
        if (lint.ok) {
            const tree = readConfigTree(deps.configFile);
            const apiKeys = readMapping(tree, "inference.apiKeys");
            const providerErrors = await validateConfiguredProviders(Object.keys(apiKeys), (key) =>
                deps.pluginHost.modelMetadata.lookupProvider(key),
            );
            errors.push(...providerErrors.map((e) => `config.yml: ${e}`));
        }

        const mcpLint = lintMcpConfigFile(deps.mcpConfigFile);
        errors.push(...mcpLint.errors.map((e) => `mcp.yml: ${e}`));
        if (mcpLint.ok) {
            const preview = deps.mcpRegistry.previewReload();
            for (const id of preview.added) {
                if (deps.toolsRegistry.hasPlugin(id)) {
                    errors.push(
                        `mcp.yml: MCP id "${id}" collides with the plugin "${id}" that contributes tools — "tools: ${id}" would be ambiguous; rename the MCP`,
                    );
                }
            }
        }
        return errors;
    }

    /**
     * Plugin-aware storage check (does each mount's `plugin:` name a
     * registered storage provider?). Runs after the plugin restarts so a
     * provider plugin enabled by this very reload counts.
     *
     * @returns Findings as warning strings.
     */
    private lintStorageAgainstProviders(): string[] {
        const findings = lintStorageStatic(this.deps.config.getValue("storage"), {
            knownPlugins: this.deps.pluginHost.storageProviders.pluginIds(),
        });
        return findings
            .filter((f) => f.severity === "error")
            .map((f) => `storage${f.alias ? `.mounts.${f.alias}` : ""}: ${f.message}`);
    }
}

/**
 * Render a {@link ReloadReport} as markdown for the CLI and the agent tool.
 *
 * @param report The reload outcome.
 * @returns Markdown text.
 */
export function renderReloadReport(report: ReloadReport): string {
    if (report.errors.length > 0) {
        return [
            "# Config reload aborted",
            "",
            "Nothing was applied; the daemon keeps running on the previous configuration.",
            "",
            ...report.errors.map((e) => `- ${e}`),
        ].join("\n");
    }
    const lines: string[] = ["# Config reloaded", ""];
    const list = (items: readonly string[]): string =>
        items.length === 0 ? "none" : items.map((i) => `\`${i}\``).join(", ");
    lines.push(`- **Applied config keys:** ${list(report.appliedKeys)}`);
    if (report.restartRequiredKeys.length > 0) {
        lines.push(
            `- **Daemon restart required for:** ${list(report.restartRequiredKeys)} (old values stay in effect until then)`,
        );
    }
    lines.push(`- **Plugins restarted:** ${list(report.plugins.restarted)}`);
    for (const failure of report.plugins.failed) {
        lines.push(`- **Plugin \`${failure.pluginId}\` failed:** ${failure.message}`);
    }
    if (report.plugins.needsDaemonRestart.length > 0) {
        lines.push(
            `- **Plugins without a stop hook (daemon restart required):** ${list(report.plugins.needsDaemonRestart)}`,
        );
    }
    lines.push(
        `- **MCPs:** added ${list(report.mcp.added)}, removed ${list(report.mcp.removed)}, changed ${list(report.mcp.changed)}`,
    );
    if (report.warnings.length > 0) {
        lines.push("", "## Warnings", "", ...report.warnings.map((w) => `- ${w}`));
    }
    lines.push(
        "",
        "Agent settings and MCP tools apply from the next agentrun on; runs in progress keep their snapshot.",
    );
    return lines.join("\n");
}

/**
 * Parse `config.yml` into a plain tree. The caller has linted the file.
 *
 * @param configFile Absolute path.
 * @returns The root mapping (empty for an empty file).
 */
function readConfigTree(configFile: string): Record<string, unknown> {
    const parsed = parse(readFileSync(configFile, "utf-8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
}

/**
 * Read a mapping at a dotted path of a parsed tree.
 *
 * @param tree Parsed config root.
 * @param key Dotted path.
 * @returns The mapping, or an empty object when absent or not a mapping.
 */
function readMapping(tree: Record<string, unknown>, key: string): Record<string, unknown> {
    let cursor: unknown = tree;
    for (const segment of key.split(".")) {
        if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
            return {};
        }
        cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor !== null && typeof cursor === "object" && !Array.isArray(cursor)
        ? (cursor as Record<string, unknown>)
        : {};
}
