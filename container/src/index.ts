import {
    AgentRunBus,
    ChatMessageBus,
    createLogger,
    EventBus,
    InferenceEventBus,
    jsonStdoutStream,
    type LogLevel,
    POSTGRES_DB,
    POSTGRES_HOST,
    POSTGRES_PORT,
    POSTGRES_USER,
    PostgresConnection,
    ScheduledSubagentBus,
    StepResultBus,
    ToolCallBus,
} from "@getfamiliar/shared";
import { AgentrunScheduler, subscribeAgentrunsChanges } from "./AgentrunScheduler.js";
import { AgentRunner } from "./agent-runner/AgentRunner.js";
import { ChatManager } from "./chat/ChatManager.js";
import { EventWatcher } from "./EventWatcher.js";
import { HandlerFile } from "./HandlerFile.js";
import { McpClientPool } from "./mcp/McpClientPool.js";
import { PluginToolsClient } from "./plugins/ToolsClient.js";
import { AgentrunRecovery } from "./recovery/AgentrunRecovery.js";
import { RealClock } from "./testing/MockClock.js";
import { reportContainerToolCatalog } from "./tools/ToolCatalogClient.js";
import { ToolsFactory } from "./tools/ToolsFactory.js";
import { PassedConfig, resolveTimezone } from "./utils/PassedConfig.js";

/**
 * Process-wide handler-header defaults. A handler can override any of
 * these in its YAML frontmatter; values left undeclared fall through
 * to these defaults.
 *
 * `maxOutputTokens` is deliberately absent: when a handler declares no
 * cap it is derived per-run from the resolved model's metadata in
 * `AgentRunner` (see `deriveMaxOutputTokens`), so it must reach that
 * code as `undefined` rather than a hard-coded number.
 */
const HEADER_DEFAULTS = {};

/**
 * Container entry point. Owns the postgres connection, builds the
 * AgentrunScheduler with all its dependencies wired from the
 * environment, spawns the input-event watcher alongside it, and
 * closes everything on SIGTERM / SIGINT.
 */
async function main(): Promise<void> {
    const log = createLogger({
        component: "container",
        level: parseLevel(PassedConfig.get<string>("core.logLevel")),
        streams: [jsonStdoutStream()],
    });

    const postgresPassword = PassedConfig.get<string>("core.postgresPassword");
    if (!postgresPassword) {
        throw new Error(
            "core.postgresPassword is not set in the passed container config. " +
                "The host daemon should have included it in FAMILIAR_CONTAINER_CONFIG.",
        );
    }
    const bastionUrl = PassedConfig.get<string>("bastionUrl");
    if (!bastionUrl) {
        throw new Error(
            "bastionUrl is not set in the passed container config. " +
                "The host daemon should have included it in FAMILIAR_CONTAINER_CONFIG.",
        );
    }

    HandlerFile.setHeaderDefaults(HEADER_DEFAULTS);

    const connection = new PostgresConnection({
        host: POSTGRES_HOST,
        port: POSTGRES_PORT,
        user: POSTGRES_USER,
        password: postgresPassword,
        database: POSTGRES_DB,
    });

    const mcpPool = new McpClientPool({
        bastionUrl,
        log: log.child({ component: "mcp-client-pool" }),
    });
    await mcpPool.start();

    // Report our built-in tool catalog to the host so the `tools list`
    // CLI can show built-ins. Best-effort — a failed report only leaves
    // the host's built-in listing stale.
    await reportContainerToolCatalog(
        bastionUrl,
        await ToolsFactory.catalog(),
        log.child({ component: "tool-catalog-report" }),
    );

    const pluginToolsClient = new PluginToolsClient({
        bastionUrl,
        log: log.child({ component: "plugin-tools-client" }),
    });

    const eventWatcher = new EventWatcher(connection, log);

    const agentRunBus = new AgentRunBus(connection, log.child({ component: "agentrun-bus" }));
    const eventBus = new EventBus(connection, log.child({ component: "event-bus" }));
    const stepBus = new StepResultBus(connection, log.child({ component: "step-bus" }));
    const inferenceEventBus = new InferenceEventBus(connection);
    const toolCallBus = new ToolCallBus(connection);
    const scheduledSubagentBus = new ScheduledSubagentBus(
        connection,
        log.child({ component: "scheduled-subagent-bus" }),
    );
    const chat = new ChatManager(new ChatMessageBus(connection));
    const recovery = new AgentrunRecovery(connection, log.child({ component: "recovery" }));
    const timezone = resolveTimezone();

    const stepTimeoutMs = (PassedConfig.get<number>("core.agentStepTimeout") ?? 150) * 1000;
    const retryCap = PassedConfig.get<number>("inference.maxRetries") ?? 3;

    const scheduler = new AgentrunScheduler({
        agentRunBus,
        eventBus,
        stepBus,
        inferenceEventBus,
        toolCallBus,
        scheduledSubagentBus,
        timezone,
        log: log.child({ component: "agentrun-scheduler" }),
        clock: RealClock,
        runnerFactory: () => new AgentRunner(),
        mcpPool,
        pluginToolsClient,
        chat,
        recovery,
        stepTimeoutMs,
        retryCap,
        maxToolDescriptionChars: PassedConfig.get<number>("core.maxToolDescriptionChars"),
        toolDefinitionsContextFraction: PassedConfig.get<number>(
            "core.toolDefinitionsContextFraction",
        ),
        toolHeuristicRunWindow: PassedConfig.get<number>("core.toolHeuristicRunWindow"),
        maxConcurrentExecuting: 1,
        subscribeChanges: (handler) => subscribeAgentrunsChanges(connection, handler),
    });

    const abortController = new AbortController();
    const shutdown = (signal: string) => {
        log.info(`draining (signal=${signal})`);
        abortController.abort();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    try {
        await Promise.all([
            eventWatcher.run(abortController.signal),
            scheduler.start(abortController.signal),
        ]);
    } finally {
        await mcpPool.close();
        await connection.close();
        log.info("agent container exiting cleanly");
    }
}

/** Coerce the passed `core.logLevel` to a {@link LogLevel}, defaulting to `info`. */
function parseLevel(raw: string | undefined): LogLevel {
    if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
        return raw;
    }
    return "info";
}

main().catch((err) => {
    // Fall back to stderr for the very first crash since the logger
    // itself may not have been built yet.
    console.error("Fatal:", err);
    process.exit(1);
});
