import {
    AgentRunBus,
    type AgentRunRow,
    ChatMessageBus,
    createLogger,
    DEFAULT_TOOL_CALL_OFFLOADING_LIMIT,
    type LogStream,
    POSTGRES_DB,
    POSTGRES_HOST,
    POSTGRES_PORT,
    POSTGRES_USER,
    PostgresConnection,
    ScheduledSubagentBus,
    ToolCallBus,
} from "@getfamiliar/shared";
import { ChatManager } from "../chat/ChatManager.js";
import { HandlerFile } from "../HandlerFile.js";
import { HostToolsClient } from "../host-tools/HostToolsClient.js";
import { McpClientPool } from "../mcp/McpClientPool.js";
import { buildPromptParts } from "../PromptBuilder.js";
import { combineToolEntries, loadPreloadedSkills } from "../SkillFile.js";
import { ToolsFactory } from "../tools/ToolsFactory.js";
import { requireConfig, resolveTimezone } from "../utils/PassedConfig.js";

/**
 * `familiar prompt dry-run`, container side. Run by the host CLI via
 * `docker exec familiar-agent … tsx src/prompt/PromptDryRun.ts '<json>'`
 * inside the running agent container, because only there the real tool
 * pool (MCP gateway, plugin tools, built-ins) and the workspace mount
 * exist.
 *
 * Resolves the handler exactly like a run would, builds its tool set,
 * renders the prompt template — without inserting an agentrun or calling
 * a model — and prints one JSON document ({@link DryRunOutput}) to
 * stdout. Logs go to stderr.
 */

/** Input passed as the single JSON argument. */
interface DryRunInput {
    readonly topic: string;
    readonly handler: string;
    readonly prompt: string | null;
    readonly privileged: boolean;
}

/** One placeholder row of the dry-run report. */
interface DryRunPlaceholder {
    readonly name: string;
    /** Resolved value, or `null` when nothing resolved it. */
    readonly value: string | null;
    /** Whether the template (or one of its includes) references it. */
    readonly isUsed: boolean;
    /** Whether a reference sits before `{CACHE_MARKER}`. */
    readonly isBeforeMarker: boolean;
}

/** JSON document printed to stdout. */
export interface DryRunOutput {
    readonly handlerPath: string;
    readonly templatePath: string | null;
    readonly toolNames: readonly string[];
    readonly placeholders: readonly DryRunPlaceholder[];
    readonly appenderSections: readonly { readonly pluginId: string; readonly text: string }[];
    readonly warnings: readonly string[];
    readonly system: string;
    readonly userHead: string;
}

/** Synthetic event / agentrun ids handed to tool builders; never persisted. */
const DRY_RUN_EVENT_ID = "dry-run-event";
const DRY_RUN_AGENTRUN_ID = "dry-run-agentrun";

/**
 * Parse the CLI argument.
 *
 * @param raw The JSON string from `process.argv[2]`.
 * @returns The parsed input.
 * @throws When the argument is missing or malformed.
 */
function parseInput(raw: string | undefined): DryRunInput {
    if (raw === undefined) {
        throw new Error("usage: PromptDryRun.ts '<json {topic, handler, prompt, privileged}>'");
    }
    const parsed = JSON.parse(raw) as Partial<DryRunInput>;
    if (typeof parsed.topic !== "string" || typeof parsed.handler !== "string") {
        throw new Error("dry-run input needs string fields topic and handler");
    }
    return {
        topic: parsed.topic,
        handler: parsed.handler,
        prompt: typeof parsed.prompt === "string" ? parsed.prompt : null,
        privileged: parsed.privileged === true,
    };
}

/**
 * Build a synthetic root agentrun row for the tool builders.
 *
 * @param input The dry-run input.
 * @returns A row that is never written to the bus.
 */
function buildSyntheticRow(input: DryRunInput): AgentRunRow {
    const now = new Date();
    return {
        id: DRY_RUN_AGENTRUN_ID,
        eventId: DRY_RUN_EVENT_ID,
        parentAgentrunId: null,
        topic: input.topic,
        handler: input.handler,
        model: null,
        priority: 0,
        state: "running",
        prompt: input.prompt,
        systemPrompt: null,
        initialMessages: null,
        payload: null,
        result: null,
        resultText: null,
        error: null,
        privileged: input.privileged,
        calltype: null,
        retryCount: 0,
        notBefore: null,
        createdAt: now,
        updatedAt: now,
    };
}

/**
 * Run the dry run and print the report.
 *
 * @throws When the handler cannot be resolved or the template is missing.
 */
async function main(): Promise<void> {
    const input = parseInput(process.argv[2]);
    const log = createLogger({
        component: "prompt-dry-run",
        level: "warn",
        streams: [{ stream: process.stderr as unknown as LogStream["stream"] }],
    });
    const bastionUrl = requireConfig<string>("bastionUrl");
    const bastionToken = requireConfig<string>("bastionToken");

    const handler = HandlerFile.load(input.topic, input.handler);
    const preloadedSkills = loadPreloadedSkills(handler);
    const row = buildSyntheticRow(input);

    const connection = new PostgresConnection({
        host: POSTGRES_HOST,
        port: POSTGRES_PORT,
        user: POSTGRES_USER,
        password: requireConfig<string>("core.postgresPassword"),
        database: POSTGRES_DB,
    });
    const mcpPool = new McpClientPool({ bastionUrl, bastionToken, log });
    await mcpPool.start();
    try {
        const hostToolset = await new HostToolsClient({ bastionUrl, bastionToken, log }).tools(
            DRY_RUN_EVENT_ID,
            DRY_RUN_AGENTRUN_ID,
            DEFAULT_TOOL_CALL_OFFLOADING_LIMIT,
        );
        const tools = await ToolsFactory.build({
            chat: new ChatManager(new ChatMessageBus(connection)),
            eventId: DRY_RUN_EVENT_ID,
            tools: combineToolEntries(handler.header.tools, preloadedSkills),
            bus: new AgentRunBus(connection, log),
            scheduledSubagentBus: new ScheduledSubagentBus(connection, log),
            timezone: resolveTimezone(),
            parent: row,
            waitForSubagent: () => Promise.reject(new Error("dry run: subagents are not executed")),
            mcpTools: mcpPool.tools(),
            mcpKeysById: mcpPool.mcpKeysById(),
            mcpLevelsByKey: mcpPool.mcpLevelsByKey(),
            pluginTools: hostToolset.tools,
            pluginKeysById: hostToolset.keysById,
            pluginGroupKeys: hostToolset.groupKeys,
            pluginLevelsByKey: hostToolset.levelsByKey,
            log,
            toolCallBus: new ToolCallBus(connection),
            handlerPath: handler.relativePath,
        });
        const toolNames = Object.keys(tools);

        const parts = await buildPromptParts({
            handler,
            topic: input.topic,
            privileged: input.privileged,
            toolNames,
            preloadedSkills,
            eventId: DRY_RUN_EVENT_ID,
            plugins: {
                bastionUrl,
                bastionToken,
                run: { dryRun: input },
                log,
            },
            shouldResolveAllCore: true,
        });

        const names = new Set([...parts.values.keys(), ...parts.uses.map((use) => use.name)]);
        const placeholders: DryRunPlaceholder[] = [...names].map((name) => {
            const uses = parts.uses.filter((use) => use.name === name);
            return {
                name,
                value: parts.values.get(name) ?? null,
                isUsed: uses.length > 0,
                isBeforeMarker: uses.some((use) => use.isBeforeMarker),
            };
        });
        const output: DryRunOutput = {
            handlerPath: handler.relativePath,
            templatePath: parts.templatePath,
            toolNames,
            placeholders,
            appenderSections: parts.appenderSections,
            warnings: parts.warnings,
            system: parts.system,
            userHead: parts.userHead,
        };
        await new Promise<void>((resolve) =>
            process.stdout.write(JSON.stringify(output), () => resolve()),
        );
    } finally {
        await mcpPool.close();
        await connection.close();
    }
}

main().then(
    () => process.exit(0),
    (err: unknown) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    },
);
