import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import {
    type ConfigService,
    createLogger,
    DEFAULT_TOOL_CALL_OFFLOADING_LIMIT,
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
import { EventContextGateway } from "../bastion/EventContextGateway.js";
import { ModelMetadataGateway } from "../bastion/ModelMetadataGateway.js";
import { buildProviders, ReverseProxy } from "../bastion/ReverseProxy.js";
import { ChatCompactor } from "../chat/ChatCompactor.js";
import { lintOrThrow } from "../config/ConfigLinter.js";
import { HostConfigService } from "../config/ConfigService.js";
import {
    AGENT_IMAGE_TAG,
    AgentContainer,
    DEFAULT_PYTHON_PACKAGES,
    ensureAgentImage,
    type LogSystemPromptMode,
} from "../container-runner/AgentContainer.js";
import {
    BASTION_BRIDGE_HOST,
    BastionBridgeContainer,
    BRIDGE_IMAGE_TAG,
    ensureBridgeImage,
} from "../container-runner/BastionBridgeContainer.js";
import { ContainerToolsGateway } from "../container-tools/ContainerToolsGateway.js";
import { ContainerToolsRegistry } from "../container-tools/ContainerToolsRegistry.js";
import { CronjobScheduler } from "../cron/CronjobScheduler.js";
import { ModelMetadataRefresher } from "../cron/ModelMetadataRefresher.js";
import { ScheduledHandlerScheduler } from "../cron/ScheduledHandlerScheduler.js";
import { ScratchGc } from "../cron/ScratchGc.js";
import { ensureNetwork, ISOLATED_NETWORK_NAME, SHARED_NETWORK_NAME } from "../DockerTools.js";
import { PostgresContainer } from "../db/PostgresContainer.js";
import { McpGateway } from "../mcp/McpGateway.js";
import { McpRegistry } from "../mcp/McpRegistry.js";
import {
    type ResolvedProvider,
    validateConfiguredProviders,
} from "../models/ProviderResolution.js";
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

/** 24 hours in milliseconds — staleness window for the models.dev cache. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `familiar start` — bring up the daemon: postgres, schema, agent container,
 * then idle waiting for SIGTERM/SIGINT to drain everything cleanly.
 *
 * Start order:   familiar-net + familiar-isolated → postgres → schema → bastion (LLM proxy + MCP gateway) → bastion bridge → agent
 * Stop order:    plugin host → agent → bastion bridge → bastion → postgres
 */
export const startCommand = defineCommand({
    meta: {
        name: "start",
        description: "Start the host daemon in the foreground.",
    },
    args: {
        verbose: {
            type: "boolean",
            alias: "v",
            description: "Enable debug-level logging.",
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
        const inferenceOutputFallbackPercentage = config.getNumber(
            "inference.outputFallbackPercentage",
            0.7,
        );
        const agentStepTimeoutSeconds = config.getNumber("core.agentStepTimeout", 150);
        const toolCallOffloadingLimit = config.getNumber(
            "core.toolCallOffloadingLimit",
            DEFAULT_TOOL_CALL_OFFLOADING_LIMIT,
        );
        const inferenceKeptToolResultCount = config.getNumber(
            "inference.contextManagement.keptToolResultCount",
            3,
        );
        const inferenceSlidingWindowPercentage = config.getNumber(
            "inference.contextManagement.slidingWindowPercentage",
            0.7,
        );
        // In dev mode, default the inference debug captures to on when
        // the operator hasn't pinned a value in config.yml. Explicit
        // `true`/`false`/`"full"`/`"non-static"` in config always wins;
        // in production the default is `"off"` so handler iteration
        // doesn't add load to a deployed daemon.
        const logSystemPromptMode: LogSystemPromptMode = resolveLogSystemPromptMode(config, dev);
        // Operator's preferred timezone. Empty when unset; the agent
        // container falls back to its own system tz, matching how the
        // host plugins fall back via getCoreTimezone().
        const coreTimezone = config.getString("core.timezone", "") ?? "";
        // Paths writable by non-privileged runs (and quoted in full by
        // the memory plugin). Accepts a bare string or a list; defaults
        // to the curated wiki plus the general-purpose files/ drop. These
        // are the *only* paths a non-privileged run may write — forwarded
        // to the agent container's fs gate and OS sandbox as
        // CORE_WRITABLE_PATHS.
        const writablePaths = config.getStringList("core.writablePaths", ["wiki/**", "files/**"]);
        // Touch the chat-channel default so a missing value fails the
        // daemon now rather than at first chat event.
        config.getString("core.defaultChatChannel");
        // Provider keys configured under inference.apiKeys. Each must
        // resolve to a known provider (models.dev or a plugin); the
        // reverse-proxy provider table + container env are built from the
        // resolved set below, once the plugin host + metadata catalogue
        // are available.
        const apiKeys = config.getMapping("inference.apiKeys", {});

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

        // Resolve every configured provider against the models.dev
        // catalogue + plugin descriptors. Refresh the catalogue first so
        // resolution sees a current copy (no-op when fresh). Validate up
        // front and fail fast with one clear diagnostic, then build the
        // reverse-proxy provider table and the container's provider→npm
        // map from the resolved set.
        await pluginHost.modelMetadata.refreshIfStale(ONE_DAY_MS);
        const providerKeys = Object.keys(apiKeys);
        const providerErrors = await validateConfiguredProviders(providerKeys, (key) =>
            pluginHost.modelMetadata.lookupProvider(key),
        );
        if (providerErrors.length > 0) {
            throw new Error(
                `inference provider config invalid:\n  - ${providerErrors.join("\n  - ")}`,
            );
        }
        const resolvedProviders = (
            await Promise.all(providerKeys.map((key) => pluginHost.resolveProvider(key)))
        ).filter((p): p is ResolvedProvider => p !== undefined);
        const providers = buildProviders(resolvedProviders);
        const providerNpmPackages: Record<string, string> = {};
        for (const provider of resolvedProviders) {
            providerNpmPackages[provider.key] = provider.npmPackage;
        }

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
        const captureInitialMessageHistory = config.getBool(
            "inference.captureInitialMessageHistory",
            false,
        );
        const reverseProxy = new ReverseProxy({
            providers,
            log: log.child({ component: "reverse-proxy" }),
            captureModelHttpRequestBodies,
            captureDir: boot.llmDebugDir,
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
        // The agent container reports its built-in tool catalog here on
        // startup; the registry backs both `tools list` and `tool_list`.
        const containerToolsRegistry = new ContainerToolsRegistry();
        pluginHost.setContainerToolsRegistry(containerToolsRegistry);
        const containerToolsGateway = new ContainerToolsGateway({
            registry: containerToolsRegistry,
            log: log.child({ component: "container-tools-gateway" }),
        });
        const eventContextGateway = new EventContextGateway({
            registry: pluginHost.eventContext,
            ensureConnection: () => pluginHost.ensureConnection(),
            log: log.child({ component: "event-context-gateway" }),
        });
        const modelMetadataGateway = new ModelMetadataGateway({
            service: pluginHost.modelMetadata,
            log: log.child({ component: "model-metadata-gateway" }),
        });
        const bastion = new Bastion({
            log: log.child({ component: "bastion" }),
            modules: [
                reverseProxy,
                mcpGateway,
                pluginToolsGateway,
                containerToolsGateway,
                eventContextGateway,
                modelMetadataGateway,
            ],
        });

        await ensureNetwork(SHARED_NETWORK_NAME);
        log.info(`ensured network '${SHARED_NETWORK_NAME}'`);

        // Egress-less network the locked-down agent joins. Postgres is
        // dual-homed onto it and the bastion bridge straddles it, so the
        // agent reaches both by name but has no route to the internet.
        await ensureNetwork(ISOLATED_NETWORK_NAME, { internal: true });
        log.info(`ensured internal network '${ISOLATED_NETWORK_NAME}'`);

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
        log.info(`bastion server started; the bridge sidecar forwards to it at ${bastion.url}`);

        // With the bastion live, point plugin MCP calls at the actual
        // loopback URL. Calling before `bastion.start()` would throw
        // (the port isn't bound yet); calling after — but before any
        // plugin daemon runs — guarantees first-call connects succeed.
        pluginHost.setBastionBaseUrl(bastion.loopbackUrl);

        // The locked-down agent has no route to the host, so it can't
        // dial the bastion at `host.docker.internal` directly. Start the
        // socat bridge sidecar — on `familiar-net` it reaches the host
        // bastion, on `familiar-isolated` it serves the agent — and point
        // the agent's `BASTION_URL` at it.
        await ensureBridgeImage(log);
        const bridge = new BastionBridgeContainer({
            imageName: BRIDGE_IMAGE_TAG,
            bastionPort: bastion.listenPort,
        });
        await bridge.start();
        const agentBastionUrl = `http://${BASTION_BRIDGE_HOST}:${bastion.listenPort}`;
        log.info(`bastion bridge started; agent will dial ${agentBastionUrl}`);

        // Python packages baked into the agent image's venv for the bash
        // tool (the container is offline; nothing can be added at runtime).
        const pythonPackages = config.getStringList("python.packages", DEFAULT_PYTHON_PACKAGES);
        await ensureAgentImage(log, pythonPackages);

        const container = new AgentContainer({
            imageName: AGENT_IMAGE_TAG,
            dataPath: boot.dataDir,
            containerSrcPath: boot.containerSrcDir,
            sharedBuildPath: boot.sharedBuildDir,
            scratchPath: boot.scratchDir,
            postgresPassword,
            bastionUrl: agentBastionUrl,
            defaultProvider,
            defaultModel,
            inferenceMaxRetries,
            inferenceOutputFallbackPercentage,
            toolCallOffloadingLimit,
            inferenceKeptToolResultCount,
            inferenceSlidingWindowPercentage,
            agentStepTimeoutSeconds,
            logSystemPromptMode,
            captureRawStepResultToDatabase,
            captureInitialMessageHistory,
            providerNpmPackages,
            verbose: debugLogging,
            coreTimezone,
            writablePaths,
            pythonPackages,
            hostUid: boot.hostUid,
            hostGid: boot.hostGid,
        });

        await container.start();
        log.info(
            { running: container.isRunning, container: "familiar-agent" },
            "agent container started",
        );

        const containerLogStream = streamContainerLogs(log, "familiar-agent");

        // The workspace watcher must exist before plugin daemons start
        // because plugins reach it via `ctx.workspace.onMarkdownFileUpdate(...)`
        // (or `listMarkdownFiles`) from inside their `start(ctx)` hook.
        // Starting the watcher first also means subscriptions land after the
        // initial scan settles, so they only fire on actual changes (no
        // initial-replay flood).
        const workspaceWatcher = new WorkspaceWatcher({
            workspaceDir: boot.workspaceDir,
            log: log.child({ component: "workspace-watcher" }),
        });
        await workspaceWatcher.start();
        pluginHost.setWorkspaceWatcher(workspaceWatcher);

        await pluginHost.startDaemons();
        log.info("plugin daemons started");

        // Cron-fired events go through HostContextImpl, not raw
        // EventBus.add. The host-side ctx.events.emit path is where
        // core.defaultChatChannel is stamped onto preferredChatChannelId
        // for events that don't carry one. Without that stamping, any
        // chat message the agent produces in response (send_chat) ends
        // up on an empty channel and no chat plugin claims it.
        const cronCtx = new HostContextImpl({
            pluginId: "core",
            ensureConnection: () => pluginHost.ensureConnection(),
            config,
            log: log.child({ component: "cron-scheduler" }),
            dataDir: boot.dataDir,
            tmpDir: boot.tmpDir,
            scratchDir: boot.scratchDir,
            pidFile: boot.pidFile,
            mcp: pluginHost.mcp,
            calendar: pluginHost.calendar,
            mail: pluginHost.mail,
            mailStyleStore: pluginHost.mailStyle,
            eventContextRegistry: pluginHost.eventContext,
            resolveProvider: (key) => pluginHost.resolveProvider(key),
            workspaceWatcher,
            // Daemon-internal context: the daemon owns its own shutdown,
            // so there's no "other daemon" to watch. A fresh, never-
            // aborted signal keeps the {@link HostContext} contract
            // (signal always present) without spuriously firing.
            daemonDownSignal: new AbortController().signal,
        });
        const cronScheduler = new CronjobScheduler({
            watcher: workspaceWatcher,
            emit: async (event) => {
                const handle = await cronCtx.events.emit(event);
                return { id: handle.id };
            },
            log: log.child({ component: "cron-scheduler" }),
            writablePathGlobs: writablePaths,
        });
        await cronScheduler.start();

        const chatCompactor = new ChatCompactor({
            connection: await pluginHost.ensureConnection(),
            host: cronCtx,
            workspaceDir: boot.workspaceDir,
            config,
            log: log.child({ component: "chat-compactor" }),
        });
        await chatCompactor.start();

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

        // The models.dev cache was already refreshed (refresh-if-stale)
        // before provider resolution above; keep it fresh daily from here.
        const modelMetadataRefresher = new ModelMetadataRefresher({
            service: pluginHost.modelMetadata,
            log: log.child({ component: "model-metadata-refresher" }),
        });
        modelMetadataRefresher.start();

        let shuttingDown = false;
        const shutdown = async (signal: string) => {
            if (shuttingDown) {
                return;
            }
            shuttingDown = true;
            log.info(`draining (signal=${signal})`);

            const orderedSteps = async (): Promise<"done"> => {
                // Remove the pidfile *first* so any long-running CLI
                // (cli-chat, future REPLs) polling daemon liveness sees
                // the daemon go away before postgres or the bastion are
                // torn down. That lets the CLI react via
                // `ctx.daemonDownSignal` and exit cleanly instead of
                // hanging on a NOTIFY that will never come — or worse,
                // flooding stderr with pg-pool reconnect errors as the
                // postgres container disappears underneath it.
                removePidFile(boot.pidFile);
                scratchGc.stop();
                modelMetadataRefresher.stop();
                await safeStop(log, "scheduled-handler scheduler", () =>
                    scheduledHandlerScheduler.stop(),
                );
                await safeStop(log, "chat compactor", () => chatCompactor.stop());
                await safeStop(log, "cron scheduler", () => cronScheduler.stop());
                await safeStop(log, "workspace watcher", () => workspaceWatcher.stop());
                await safeStop(log, "plugin host", () => pluginHost.close());
                await safeStop(log, "agent container", () => container.stop());
                await safeStop(log, "bastion bridge", () => bridge.stop());
                await safeStop(log, "bastion", () => bastion.stop());
                await safeStop(log, "postgres", () => postgres.stop());
                stopContainerLogStream(containerLogStream);
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

/**
 * Resolve `core.logSystemPrompt` (which may be a boolean or the
 * strings `"full"` / `"non-static"`) into the {@link LogSystemPromptMode}
 * the agent container actually consumes. When unset, defaults to
 * `"full"` in dev and `"off"` in prod. Malformed values would already
 * have been flagged by the lint pass, but the helper still falls back
 * to the default in that case rather than throwing — the daemon would
 * otherwise refuse to boot over an audit-only knob.
 */
function resolveLogSystemPromptMode(config: ConfigService, dev: boolean): LogSystemPromptMode {
    const asBool = config.getBool("core.logSystemPrompt", undefined);
    if (typeof asBool === "boolean") {
        return asBool ? "full" : "off";
    }
    const asStr = config.getString("core.logSystemPrompt", undefined);
    if (asStr === "full" || asStr === "non-static") {
        return asStr;
    }
    return dev ? "full" : "off";
}
