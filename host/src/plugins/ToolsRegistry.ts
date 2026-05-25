import {
    CORE_GROUP_NAME,
    type HostContext,
    IDENT_PATTERN,
    type Logger,
    type PluginTool,
    RESERVED_GROUP_NAMES,
    sanitizeToolKey,
} from "@getfamiliar/shared";
import type { McpRegistry } from "../mcp/McpRegistry.js";

/**
 * One tool the registry has accepted from a plugin, ready for the
 * gateway to look up at dispatch time. Bundles everything the
 * invoke path needs (the {@link execute} function, its declared
 * schema, the plugin's {@link HostContext}, a scoped logger) so the
 * gateway doesn't have to re-walk the registry per call.
 */
export interface RegisteredPluginTool {
    /** Plugin id this tool belongs to. */
    readonly pluginId: string;
    /** Bare tool name as the plugin declared it. */
    readonly toolName: string;
    /** Public agent-facing key (`${pluginId}_${sanitized toolName}`). */
    readonly key: string;
    /** Description forwarded to the agent's tool list. */
    readonly description: string;
    /** JSON Schema for the tool's args. */
    readonly inputSchema: object;
    /** Plugin's HostContext — same instance its `start`/`tools` saw. */
    readonly hostContext: HostContext;
    /** Logger child for this plugin (caller usually narrows further per-call). */
    readonly log: Logger;
    /** The plugin-provided execute function. */
    readonly execute: PluginTool["execute"];
    /**
     * Tool opted into the `system` DSL group via
     * {@link PluginTool.system}. The bastion's `/plugin-tools/` listing
     * forwards this flag to the container so its `ToolsFactory` can
     * fold the key into both the implicit default tool set and the
     * explicit `tools: system` expansion. Always `false` for core
     * tools — they live in `core`, not `system`.
     */
    readonly system: boolean;
}

/**
 * Holds every plugin-contributed tool the daemon currently knows
 * about. The {@link ToolsGateway} reads from this registry on every
 * request, so registrations must complete *before* the registry is
 * advertised to the agent — which is why the
 * {@link import("./PluginHost.js").PluginHost} populates it only
 * after each plugin's `start` resolves.
 *
 * Constraints enforced at {@link register}:
 *
 * 1. Plugin id matches {@link IDENT_PATTERN} (lowercase alnum, leading
 *    letter) so the id is usable as a DSL group name. Plugins with
 *    hyphenated ids (e.g. `cli-chat`) can ship workspace templates and
 *    commands fine; they just can't contribute tools without first
 *    renaming. The check fails loud at startup so the constraint is
 *    obvious.
 * 2. Plugin id is not in {@link RESERVED_GROUP_NAMES}. Same logic the
 *    MCP loader applies to mcp.yml keys.
 * 3. Plugin id does not collide with any MCP id. Without this, `tools:
 *    mail` would be ambiguous between the mail plugin and a (hypothetical)
 *    mail MCP.
 * 4. Each plugin registers only once. Two `register(pluginId, ...)` calls
 *    are a wiring bug, not a feature.
 * 5. No duplicate keys across the whole registry. Two plugins that both
 *    declare a `send` tool would collide as `<a>_send`/`<b>_send` already,
 *    but identical keys *within* a plugin (after sanitization) are also
 *    rejected.
 */
export class PluginToolsRegistry {
    private readonly mcp: McpRegistry;
    private readonly log: Logger;
    private readonly tools: Map<string, RegisteredPluginTool> = new Map();
    private readonly pluginIds: Set<string> = new Set();

    constructor(mcp: McpRegistry, log: Logger) {
        this.mcp = mcp;
        this.log = log;
    }

    /**
     * Register every tool a plugin declared via its `tools(ctx)` hook.
     * Validates the plugin id and each tool key against the rules in
     * the class doc; the *first* offending tool throws synchronously
     * — partial registration of a plugin's tools is not allowed.
     */
    register(pluginId: string, hostContext: HostContext, tools: readonly PluginTool[]): void {
        if (tools.length === 0) {
            return;
        }
        if (!IDENT_PATTERN.test(pluginId)) {
            throw new Error(
                `plugin "${pluginId}" contributes tools but its id is not a valid DSL group ` +
                    `name (must match ${IDENT_PATTERN}). Rename the plugin or drop its tools().`,
            );
        }
        if (RESERVED_GROUP_NAMES.has(pluginId)) {
            throw new Error(
                `plugin "${pluginId}" cannot contribute tools — id collides with a reserved ` +
                    `DSL group name (${[...RESERVED_GROUP_NAMES].join(", ")}).`,
            );
        }
        if (this.mcp.get(pluginId) !== undefined) {
            throw new Error(
                `plugin "${pluginId}" cannot contribute tools — an MCP with the same id exists ` +
                    `in mcp.yml; "tools: ${pluginId}" would be ambiguous.`,
            );
        }
        if (this.pluginIds.has(pluginId)) {
            throw new Error(`plugin "${pluginId}" already registered tools — double call?`);
        }

        const pluginLog = this.log.child({ plugin: pluginId });

        for (const tool of tools) {
            const key = sanitizeToolKey(`${pluginId}_${tool.name}`);
            if (this.tools.has(key)) {
                throw new Error(
                    `plugin "${pluginId}" tool "${tool.name}" sanitizes to key "${key}" which ` +
                        `is already registered.`,
                );
            }
            this.tools.set(key, {
                pluginId,
                toolName: tool.name,
                key,
                description: tool.description,
                inputSchema: tool.inputSchema,
                hostContext,
                log: pluginLog,
                execute: tool.execute.bind(tool),
                system: tool.system === true,
            });
        }
        this.pluginIds.add(pluginId);
    }

    /**
     * Register core (host-owned) tools — `cal_*` today, and future
     * non-plugin-scoped tools (approval-gate, system-introspection,
     * …). Bare-name keys (no plugin prefix) so the agent calls them
     * as `cal_get_events` rather than `core_cal_get_events`. The
     * `pluginId` stamp is the reserved string `"core"` so the
     * existing DSL filter machinery handles them uniformly with
     * `tools: core`.
     *
     * Re-callable (idempotent on key collision: throws), so the
     * caller can register the calendar tools and later, when a new
     * core surface lands, register those too. Each *individual*
     * tool key still has to be unique across the whole registry.
     */
    registerCoreTools(hostContext: HostContext, tools: readonly PluginTool[]): void {
        if (tools.length === 0) {
            return;
        }
        const coreLog = this.log.child({ plugin: CORE_GROUP_NAME });
        for (const tool of tools) {
            const key = sanitizeToolKey(tool.name);
            if (this.tools.has(key)) {
                throw new Error(
                    `core tool "${tool.name}" sanitizes to key "${key}" which is already ` +
                        "registered (collision with a plugin tool?).",
                );
            }
            this.tools.set(key, {
                pluginId: CORE_GROUP_NAME,
                toolName: tool.name,
                key,
                description: tool.description,
                inputSchema: tool.inputSchema,
                hostContext,
                log: coreLog,
                execute: tool.execute.bind(tool),
                // Core tools belong to the `core` group only — never
                // auto-promoted into `system`. Handlers that want them
                // must opt in via `tools: core`.
                system: false,
            });
        }
    }

    /** Snapshot of every registered tool, in insertion order. */
    list(): readonly RegisteredPluginTool[] {
        return [...this.tools.values()];
    }

    /** Lookup by the public sanitized key. */
    get(key: string): RegisteredPluginTool | undefined {
        return this.tools.get(key);
    }
}
