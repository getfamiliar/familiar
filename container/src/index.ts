import {
    AgentRunBus,
    ChatMessageBus,
    createLogger,
    DEFAULT_TOOL_CALL_OFFLOADING_LIMIT,
    EventBus,
    InferenceEventBus,
    jsonStdoutStream,
    type LogLevel,
    POSTGRES_DB,
    POSTGRES_HOST,
    POSTGRES_PORT,
    POSTGRES_USER,
    PostgresConnection,
    ScheduledHandlerBus,
    StepResultBus,
} from "@getfamiliar/shared";
import { AgentrunScheduler, subscribeAgentrunsChanges } from "./AgentrunScheduler.js";
import { AgentRunner } from "./agent-runner/AgentRunner.js";
import { ChatManager } from "./chat/ChatManager.js";
import { EventWatcher } from "./EventWatcher.js";
import { getCoreTimezone, optionalEnvInt } from "./env.js";
import { HandlerFile } from "./HandlerFile.js";
import { McpClientPool } from "./mcp/McpClientPool.js";
import { PluginToolsClient } from "./plugins/ToolsClient.js";
import { AgentrunRecovery } from "./recovery/AgentrunRecovery.js";
import { RealClock } from "./testing/MockClock.js";

/**
 * Process-wide handler-header defaults. A handler can override any of
 * these in its YAML frontmatter; values left undeclared fall through
 * to these defaults.
 */
const HEADER_DEFAULTS = {
    /** Bound the size of any single model step. See HandlerFileHeader. */
    maxOutputTokens: 1000,
};

/**
 * Container entry point. Owns the postgres connection, builds the
 * AgentrunScheduler with all its dependencies wired from the
 * environment, spawns the input-event watcher alongside it, and
 * closes everything on SIGTERM / SIGINT.
 */
async function main(): Promise<void> {
    const log = createLogger({
        component: "container",
        level: parseLevel(process.env.FAMILIAR_LOG_LEVEL),
        streams: [jsonStdoutStream()],
    });

    const postgresPassword = process.env.POSTGRES_PASSWORD;
    if (!postgresPassword) {
        throw new Error(
            "POSTGRES_PASSWORD is not set in the agent container env. " +
                "The host daemon should have passed it in via -e POSTGRES_PASSWORD=...",
        );
    }
    const bastionUrl = process.env.BASTION_URL;
    if (!bastionUrl) {
        throw new Error(
            "BASTION_URL is not set in the agent container env. " +
                "The host daemon should have passed it in via -e BASTION_URL=...",
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

    const pluginToolsClient = new PluginToolsClient({
        bastionUrl,
        log: log.child({ component: "plugin-tools-client" }),
    });

    const eventWatcher = new EventWatcher(connection, log);

    const agentRunBus = new AgentRunBus(connection, log.child({ component: "agentrun-bus" }));
    const eventBus = new EventBus(connection, log.child({ component: "event-bus" }));
    const stepBus = new StepResultBus(connection, log.child({ component: "step-bus" }));
    const inferenceEventBus = new InferenceEventBus(connection);
    const scheduledHandlerBus = new ScheduledHandlerBus(
        connection,
        log.child({ component: "scheduled-handler-bus" }),
    );
    const chat = new ChatManager(new ChatMessageBus(connection));
    const recovery = new AgentrunRecovery(connection, log.child({ component: "recovery" }));
    const timezone = getCoreTimezone();

    const stepTimeoutMs = (optionalEnvInt("AGENTSTEP_TIMEOUT_SECONDS") ?? 150) * 1000;
    const retryCap = optionalEnvInt("INFERENCE_MAX_RETRIES") ?? 3;
    const toolCallOffloadingLimit =
        optionalEnvInt("TOOL_CALL_OFFLOADING_LIMIT") ?? DEFAULT_TOOL_CALL_OFFLOADING_LIMIT;

    const scheduler = new AgentrunScheduler({
        agentRunBus,
        eventBus,
        stepBus,
        inferenceEventBus,
        scheduledHandlerBus,
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
        toolCallOffloadingLimit,
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

/** Coerce `FAMILIAR_LOG_LEVEL` to a {@link LogLevel}, defaulting to `info`. */
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
