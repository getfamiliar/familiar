import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import {
    type ConfigService,
    createLogger,
    EventBus,
    jsonStdoutStream,
    type Logger,
    type LogStream,
    prettyStdoutStream,
    ScheduledHandlerBus,
} from "@getfamiliar/shared";
import { defineCommand } from "citty";
import type { Bootstrap } from "../Bootstrap.js";
import { bootstrap, isDevMode } from "../Bootstrap.js";
import { Bastion } from "../bastion/Bastion.js";
import { buildProviders, ReverseProxy } from "../bastion/ReverseProxy.js";
import { lintOrThrow } from "../config/ConfigLinter.js";
import { HostConfigService } from "../config/ConfigService.js";
import {
    AGENT_IMAGE_TAG,
    AgentContainer,
    ensureAgentImage,
} from "../container-runner/AgentContainer.js";
import { CronjobScheduler } from "../cron/CronjobScheduler.js";
import { ScheduledHandlerScheduler } from "../cron/ScheduledHandlerScheduler.js";
import { ScratchGc } from "../cron/ScratchGc.js";
import { ensureNetwork, SHARED_NETWORK_NAME } from "../DockerTools.js";
import { PostgresContainer } from "../db/PostgresContainer.js";
import { McpGateway } from "../mcp/McpGateway.js";
import { McpRegistry } from "../mcp/McpRegistry.js";
import { HostContextImpl } from "../plugins/HostContextImpl.js";
import { PluginHost } from "../plugins/PluginHost.js";
import { PluginToolsGateway } from "../plugins/ToolsGateway.js";
import { PluginToolsRegistry } from "../plugins/ToolsRegistry.js";
import { rollingFileStream } from "../tools/LogRetentionTools.js";
import { WorkspaceWatcher } from "../workspace/WorkspaceWatcher.js";
import { acquirePidFile, removePidFile } from "./pidfile.js";

/**
 * Hard upper bound on the SIGINT/SIGTERM drain. Combined with the
 * per-step belts (mcp child grace, file-sink close race), normal
 * shutdown is well under this; the deadline only fires when
 * something genuinely wedges. On expiry the daemon force-exits
 * with code 2 so the failure mode is visible to whoever invoked
 * `cli.sh stop`.
 */
const DRAINING_DEADLINE_MS = 15_000;

/**
 * `familiar start` — bring up the daemon: postgres, schema, agent container,
 * then idle waiting for SIGTERM/SIGINT to drain everything cleanly.
 *
 * Start order:   familiar-net → postgres → schema → bastion (LLM proxy + MCP gateway) → agent
 * Stop order:    plugin host → agent → bastion → postgres
 */
export const startCommand = defineCommand({
    meta: {
        name: "start",
        description: "Start the host daemon (foreground; manages all containers).",
    },
    args: {
        verbose: {
            type: "boolean",
            alias: "v",
            description:
                "Enable debug-level logging (every NOTIFY, listener fire, step result, tool call).",
            default: false,
        },
    },
    async run({ args }) {
        const boot = bootstrap();
        const verbose = Boolean(args.verbose);
        const dev = isDevMode();
        // Dev mode raises the default log level so a `FAMILIAR_DEV=1
        // ./cli.sh start` produces debug output without also typing
        // `--verbose`. An explicit `--verbose` still wins (and in
        // production is the only way to get debug).
        const debugLogging = verbose || dev;

        // Lint first so a malformed config.yml fails with one clear
        // diagnostic instead of cascading per-call failures further
        // down the startup path. The bootstrap logger handles this
        // pre-config-load failure path; the daemon logger (with rolling
        // file sink) is built once we know logRetentionDays.
        const bootLog = createLogger({
            component: "host",
            level: debugLogging ? "debug" : "info",
            streams: [process.stdout.isTTY ? prettyStdoutStream() : jsonStdoutStream()],
        });
        lintOrThrow(boot.configFile, bootLog);

        // Single-instance enforcement: bail out *before* any
        // container is touched if a peer daemon already owns the
        // pidfile. Stale pidfiles (left over from a crash or a
        // `kill -9`) auto-recover. Done before the daemon logger
        // is built so the rolling file isn't opened in the bailing
        // process.
        acquirePidFile(boot.pidFile, bootLog);

        const config = new HostConfigService(boot.configFile);

        const postgresPassword = config.getString("core.postgresPassword");
        const defaultProvider = config.getString("inference.defaultProvider");
        const defaultModel = config.getString("inference.defaultModel");
        const inferenceMaxRetries = config.getNumber("inference.maxRetries", 3);
        const agentTimeoutSeconds = config.getNumber("core.agentTimeout", 60);
        // In dev mode, default the inference debug captures to on when
        // the operator hasn't pinned a value in config.yml. Explicit
        // `true`/`false` in config always wins; in production both
        // default to `false` so handler iteration doesn't add load to
        // a deployed daemon.
        const logSystemPrompt = config.getBool("core.logSystemPrompt", undefined) ?? dev;
        // Operator's preferred timezone. Empty when unset; the agent
        // container falls back to its own system tz, matching how the
        // host plugins fall back via getCoreTimezone().
        const coreTimezone = config.getString("core.timezone", "") ?? "";
        // Touch the chat-channel default so a missing value fails the
        // daemon now rather than at first chat event.
        config.getString("core.defaultChatChannel");
        // Build the providers map for the bastion's reverse-proxy
        // module. Every native key under `inference.apiKeys` and every
        // entry under `inference.customProviders` becomes a `/llm/<id>/`
        // route; native ids are pinned to known upstream URLs and auth
        // styles, custom ones use openai-compatible Bearer auth.
        const apiKeys = config.getMapping("inference.apiKeys", {});
        const customProviders = config.getMapping("inference.customProviders", {});
        const providers = buildProviders(apiKeys, customProviders);
        // Provider type map for the agent container — native ids carry
        // their own SDK package (id is the type), custom ids fall under
        // the single openai-compatible client.
        const providerTypes: Record<string, string> = {};
        for (const id of Object.keys(apiKeys)) {
            providerTypes[id] = id;
        }
        for (const id of Object.keys(customProviders)) {
            providerTypes[id] = "openai-compatible";
        }

        const log = await buildDaemonLogger(boot, config, debugLogging);

        ensureDirs(boot);

        // One parse of mcp.yml shared by the gateway (transports) and
        // the host-side PluginMcpService (plugin lookups). Fails fast
        // here if the file is malformed.
        const mcpRegistry = new McpRegistry(boot.mcpConfigFile, log);

        const pluginHost = new PluginHost(boot, log, config, mcpRegistry);
        pluginHost.installWorkspaceTemplates();
        log.info("plugin workspace templates installed");

        // Sync plugin init runs before any `start(ctx)` so cross-
        // plugin module state (e.g. transcribe-whisper's API key) is
        // visible to siblings the moment they begin serving.
        pluginHost.prepareAll();

        const postgres = new PostgresContainer({
            dataPath: boot.dataDir,
            portFilePath: boot.postgresPortFile,
            password: postgresPassword,
        });
        const captureModelHttpRequestBodies = config.getBool(
            "inference.captureModelHttpRequestBodies",
            false,
        );
        const captureRawStepResultToDatabase =
            config.getBool("inference.captureRawStepResultToDatabase", undefined) ?? dev;
        const reverseProxy = new ReverseProxy({
            providers,
            log: log.child({ component: "reverse-proxy" }),
            captureModelHttpRequestBodies,
            captureDir: `${boot.dataDir}/llm-debug`,
        });
        const mcpGateway = new McpGateway({
            registry: mcpRegistry,
            mcpLogsDir: boot.mcpLogsDir,
            logRetentionDays: config.getNumber("core.logRetentionDays", 7),
            tmpDir: boot.tmpDir,
            scratchDir: boot.scratchDir,
            hostUid: boot.hostUid,
            hostGid: boot.hostGid,
            log: log.child({ component: "mcp-gateway" }),
        });
        const pluginToolsRegistry = new PluginToolsRegistry(
            mcpRegistry,
            log.child({ component: "plugin-tools" }),
        );
        pluginHost.setToolsRegistry(pluginToolsRegistry);
        const pluginToolsGateway = new PluginToolsGateway({
            registry: pluginToolsRegistry,
            ensureConnection: () => pluginHost.ensureConnection(),
            log: log.child({ component: "plugin-tools-gateway" }),
        });
        const bastion = new Bastion({
            log: log.child({ component: "bastion" }),
            modules: [reverseProxy, mcpGateway, pluginToolsGateway],
        });

        await ensureNetwork(SHARED_NETWORK_NAME);
        log.info(`ensured network '${SHARED_NETWORK_NAME}'`);

        const postgresPort = await postgres.start();
        log.info(`postgres ready on 127.0.0.1:${postgresPort}`);

        const schemaConnection = postgres.getConnection();
        try {
            const bus = new EventBus(schemaConnection);
            await bus.installSchema();
            log.info("bus-state schema installed");
            // Orphan recovery (agentruns left in running/waiting,
            // events left in running) is owned by the container's
            // AgentrunScheduler — see container/src/recovery/AgentrunRecovery.ts.
            // It runs before the first scheduling pass, so the host
            // doesn't need to pre-clean.
        } finally {
            await schemaConnection.close();
        }

        await bastion.start();
        log.info(`bastion server started and reachable from container at ${bastion.url}`);

        // With the bastion live, point plugin MCP calls at the actual
        // loopback URL. Calling before `bastion.start()` would throw
        // (the port isn't bound yet); calling after — but before any
        // plugin daemon runs — guarantees first-call connects succeed.
        pluginHost.setBastionBaseUrl(bastion.loopbackUrl);

        await ensureAgentImage(log);

        const container = new AgentContainer({
            imageName: AGENT_IMAGE_TAG,
            dataPath: boot.dataDir,
            containerSrcPath: boot.containerSrcDir,
            sharedBuildPath: boot.sharedBuildDir,
            scratchPath: boot.scratchDir,
            postgresPassword,
            bastionUrl: bastion.url,
            defaultProvider,
            defaultModel,
            inferenceMaxRetries,
            agentTimeoutSeconds,
            logSystemPrompt,
            captureRawStepResultToDatabase,
            providerTypes,
            verbose: debugLogging,
            coreTimezone,
        });

        await container.start();
        log.info(
            { running: container.isRunning, container: "familiar-agent" },
            "agent container started",
        );

        const containerLogStream = streamContainerLogs(log, "familiar-agent");

        await pluginHost.startDaemons();
        log.info("plugin daemons started");

        // Cron-fired events go through HostContextImpl, not raw
        // EventBus.add. The host-side ctx.events.emit path is where
        // core.defaultChatChannel is stamped onto preferredChatChannelId
        // for events that don't carry one. Without that stamping, any
        // chat message the agent produces in response (send_chat) ends
        // up on an empty channel and no chat plugin claims it.
        const cronCtx = new HostContextImpl({
            ensureConnection: () => pluginHost.ensureConnection(),
            config,
            log: log.child({ component: "cron-scheduler" }),
            dataDir: boot.dataDir,
            scratchDir: boot.scratchDir,
            pidFile: boot.pidFile,
            mcp: pluginHost.mcp,
            calendar: pluginHost.calendar,
            mail: pluginHost.mail,
        });
        const workspaceWatcher = new WorkspaceWatcher({
            workspaceDir: boot.workspaceDir,
            log: log.child({ component: "workspace-watcher" }),
        });
        await workspaceWatcher.start();
        const cronScheduler = new CronjobScheduler({
            watcher: workspaceWatcher,
            emit: async (event) => {
                const handle = await cronCtx.events.emit(event);
                return { id: handle.id };
            },
            log: log.child({ component: "cron-scheduler" }),
        });
        await cronScheduler.start();

        const scheduledHandlerConn = await pluginHost.ensureConnection();
        const scheduledHandlerBus = new ScheduledHandlerBus(
            scheduledHandlerConn,
            log.child({ component: "scheduled-handler-bus" }),
        );
        const scheduledHandlerScheduler = new ScheduledHandlerScheduler({
            bus: scheduledHandlerBus,
            emit: async (event) => {
                const handle = await cronCtx.events.emit(event);
                return { id: handle.id };
            },
            log: log.child({ component: "scheduled-handler-scheduler" }),
        });
        await scheduledHandlerScheduler.start();

        const scratchGc = new ScratchGc({
            scratchDir: boot.scratchDir,
            log: log.child({ component: "scratch-gc" }),
        });
        scratchGc.start();

        let shuttingDown = false;
        const shutdown = async (signal: string) => {
            if (shuttingDown) {
                return;
            }
            shuttingDown = true;
            log.info(`draining (signal=${signal})`);

            const orderedSteps = async (): Promise<"done"> => {
                scratchGc.stop();
                await safeStop(log, "scheduled-handler scheduler", () =>
                    scheduledHandlerScheduler.stop(),
                );
                await safeStop(log, "cron scheduler", () => cronScheduler.stop());
                await safeStop(log, "workspace watcher", () => workspaceWatcher.stop());
                await safeStop(log, "plugin host", () => pluginHost.close());
                await safeStop(log, "agent container", () => container.stop());
                await safeStop(log, "bastion", () => bastion.stop());
                await safeStop(log, "postgres", () => postgres.stop());
                stopContainerLogStream(containerLogStream);
                removePidFile(boot.pidFile);
                return "done";
            };

            // Last-resort shutdown deadline. Even with the per-
            // step belts inside each stop method, we never want a
            // future plugin or syscall to block the daemon
            // indefinitely on SIGINT — the operator's `cli.sh
            // stop` would silently wedge. After
            // {@link DRAINING_DEADLINE_MS} we force-exit with a
            // distinct code so the failure is visible.
            const deadline = new Promise<"timeout">((resolve) =>
                setTimeout(() => resolve("timeout"), DRAINING_DEADLINE_MS),
            );
            const result = await Promise.race([orderedSteps(), deadline]);
            if (result === "timeout") {
                log.error(
                    `draining timeout exceeded after ${DRAINING_DEADLINE_MS / 1000}s — forcing exit`,
                );
                process.exit(2);
            }
            // Terminal log line. If this isn't in the rolling file
            // after a `cli.sh stop`, the shutdown wedged somewhere
            // between SIGTERM and here — exactly the failure mode
            // the deadline above guards against, but the explicit
            // line makes it visible without having to count
            // upstream "stop error" entries.
            log.info("daemon stopped cleanly");
            process.exit(0);
        };

        process.on("SIGTERM", () => {
            void shutdown("SIGTERM");
        });
        process.on("SIGINT", () => {
            void shutdown("SIGINT");
        });

        // Defense in depth: if some future plugin or library code
        // throws an unhandled async rejection, log it and keep the
        // daemon alive. The HostContextImpl emit path also attaches
        // a per-call no-op `.catch`, but the safety net here covers
        // anything that slips past (e.g. a listener that throws
        // synchronously inside an async callback). uncaughtException
        // is treated as program-level corruption — log + initiate an
        // orderly shutdown so the operator's `cli.sh start` reports
        // the failure cleanly instead of dying mid-step.
        process.on("unhandledRejection", (reason) => {
            const err = reason instanceof Error ? reason : new Error(String(reason));
            log.error(
                { err: err.message, stack: err.stack },
                "unhandledRejection — keeping daemon alive",
            );
        });
        process.on("uncaughtException", (err) => {
            log.error(
                { err: err.message, stack: err.stack },
                "uncaughtException — initiating shutdown",
            );
            void shutdown("uncaughtException");
        });

        log.info(`daemon ready (pid=${process.pid})`);

        // Keep the event loop alive until a signal arrives. A no-op interval
        // is the simplest portable handle; signal handlers alone don't pin
        // the loop in Node.
        setInterval(() => {}, 60_000);

        await new Promise<void>(() => {});
    },
});

/**
 * Build the daemon's root logger. Stdout is pretty-printed when
 * attached to a TTY, raw JSON otherwise. A second stream rolls
 * `data/logs/familiar.YYYYMMDD.<n>.log` daily; retention is read from
 * `core.logRetentionDays` and falls back to 7 when absent.
 */
async function buildDaemonLogger(
    boot: Bootstrap,
    config: ConfigService,
    verbose: boolean,
): Promise<Logger> {
    mkdirSync(boot.logsDir, { recursive: true });
    const retention = config.getNumber("core.logRetentionDays", 7);
    const streams: LogStream[] = [
        process.stdout.isTTY ? prettyStdoutStream() : jsonStdoutStream(),
        await rollingFileStream(boot.logsDir, "familiar", retention),
    ];
    return createLogger({
        component: "host",
        level: verbose ? "debug" : "info",
        streams,
    });
}

/**
 * Spawn `docker logs -f --tail 0` against the agent container and
 * funnel each stdout line back into the host logger. JSON lines (the
 * container's pino output) are reconstructed as structured records
 * with the `source: 'container'` tag so they merge naturally with
 * host records. Non-JSON lines (tsx-watch banner, runtime warnings)
 * pass through as plain `info` messages.
 */
function streamContainerLogs(log: Logger, container: string): ChildProcess {
    const proc = spawn("docker", ["logs", "-f", "--tail", "0", container], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    const containerLog = log.child({ source: "container" });
    const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            return;
        }
        if (trimmed.startsWith("{")) {
            try {
                forwardJson(containerLog, JSON.parse(trimmed));
                return;
            } catch {
                // Fall through to plain-text path on malformed JSON.
            }
        }
        containerLog.info(trimmed);
    };
    if (proc.stdout) {
        createInterface({ input: proc.stdout }).on("line", handleLine);
    }
    if (proc.stderr) {
        createInterface({ input: proc.stderr }).on("line", handleLine);
    }
    proc.on("error", (err) => {
        log.error(`docker logs stream error for ${container}: ${err.message}`);
    });
    return proc;
}

/**
 * Re-emit a parsed pino record from the container through the host
 * logger. Strips fields the host adds itself (`time`, `pid`,
 * `hostname`) and maps the numeric pino level back to a method name.
 */
function forwardJson(log: Logger, record: Record<string, unknown>): void {
    const { level, msg, time, pid, hostname, ...rest } = record;
    const methodName = pinoLevelToMethod(typeof level === "number" ? level : 30);
    void time;
    void pid;
    void hostname;
    const message = typeof msg === "string" ? msg : "";
    log[methodName](rest, message);
}

/** Convert a pino numeric level (10/20/30/40/50) to our Logger method. */
function pinoLevelToMethod(level: number): "debug" | "info" | "warn" | "error" {
    if (level >= 50) {
        return "error";
    }
    if (level >= 40) {
        return "warn";
    }
    if (level >= 30) {
        return "info";
    }
    return "debug";
}

/** Best-effort kill of the docker-logs follower during shutdown. */
function stopContainerLogStream(proc: ChildProcess): void {
    if (proc.exitCode === null && !proc.killed) {
        proc.kill("SIGTERM");
    }
}

/**
 * Run a stop step and log any error without aborting the rest of the
 * shutdown sequence. We want every component to get a chance to clean up.
 */
async function safeStop(log: Logger, label: string, stop: () => Promise<void>): Promise<void> {
    try {
        await stop();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`stop error in ${label}: ${message}`);
    }
}

/** Ensure all directories the daemon and agent container expect are present. */
function ensureDirs(boot: ReturnType<typeof bootstrap>): void {
    mkdirSync(boot.workspaceDir, { recursive: true });
    mkdirSync(boot.logsDir, { recursive: true });
    mkdirSync(boot.mcpLogsDir, { recursive: true });
    mkdirSync(boot.scratchDir, { recursive: true });
}
