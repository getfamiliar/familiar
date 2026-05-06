import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { defineCommand } from "citty";
import {
    type ConfigService,
    createLogger,
    EventBus,
    jsonStdoutStream,
    type Logger,
    type LogStream,
    prettyStdoutStream,
} from "effective-assistant-shared";
import type { Bootstrap } from "../Bootstrap.js";
import { bootstrap } from "../Bootstrap.js";
import { lintOrThrow } from "../config/ConfigLinter.js";
import { HostConfigService } from "../config/ConfigService.js";
import { AgentContainer } from "../container-runner/AgentContainer.js";
import { ReverseProxyContainer } from "../container-runner/ReverseProxyContainer.js";
import { ensureNetwork, SHARED_NETWORK_NAME } from "../DockerTools.js";
import { PostgresContainer } from "../db/PostgresContainer.js";
import { PluginHost } from "../plugins/PluginHost.js";
import { rollingFileStream } from "../tools/LogRetentionTools.js";

const FEATHERLESS_UPSTREAM_BASE = "https://api.featherless.ai";
const FEATHERLESS_BASE_URL_FOR_AGENT = "http://ea-reverse-proxy:8788/v1";

/**
 * `ea start` — bring up the daemon: postgres, schema, agent container,
 * then idle waiting for SIGTERM/SIGINT to drain everything cleanly.
 *
 * Start order:   ea-net → postgres → schema → agent
 * Stop order:    agent  → postgres
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

        // Lint first so a malformed config.yml fails with one clear
        // diagnostic instead of cascading per-call failures further
        // down the startup path. The bootstrap logger handles this
        // pre-config-load failure path; the daemon logger (with rolling
        // file sink) is built once we know logRetentionDays.
        const bootLog = createLogger({
            component: "host",
            level: verbose ? "debug" : "info",
            streams: [process.stdout.isTTY ? prettyStdoutStream() : jsonStdoutStream()],
        });
        lintOrThrow(boot.configFile, bootLog);
        const config = new HostConfigService(boot.configFile);

        const postgresPassword = config.getString("core.postgresPassword");
        const provider = config.getString("inference.provider");
        const upstreamInferenceKey = config.getString(`inference.apiKeys.${provider}`);
        // Touch the chat-channel default so a missing value fails the
        // daemon now rather than at first chat event.
        config.getString("core.defaultChatChannel");

        const log = await buildDaemonLogger(boot, config, verbose);

        ensureDirs(boot);
        writePidFile(boot.pidFile);

        const pluginHost = new PluginHost(boot, log, config);
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
        const reverseProxy = new ReverseProxyContainer({
            imageName: "ea-reverse-proxy",
            upstreamBase: FEATHERLESS_UPSTREAM_BASE,
            upstreamApiKey: upstreamInferenceKey,
        });
        const container = new AgentContainer({
            imageName: "effective-agent",
            dataPath: boot.dataDir,
            containerSrcPath: boot.containerSrcDir,
            postgresPassword,
            featherlessBaseUrl: FEATHERLESS_BASE_URL_FOR_AGENT,
            verbose,
        });

        await ensureNetwork(SHARED_NETWORK_NAME);
        log.info({ network: SHARED_NETWORK_NAME }, "ensured network");

        const postgresPort = await postgres.start();
        log.info({ host: "127.0.0.1", port: postgresPort }, "postgres ready");

        const schemaConnection = postgres.getConnection();
        try {
            const bus = new EventBus(schemaConnection);
            await bus.installSchema();
            log.info("bus-state schema installed");
        } finally {
            await schemaConnection.close();
        }

        await reverseProxy.start();
        log.info(
            { running: reverseProxy.isRunning, container: "ea-reverse-proxy" },
            "reverse proxy started",
        );

        await container.start();
        log.info(
            { running: container.isRunning, container: "ea-agent" },
            "agent container started",
        );

        const containerLogStream = streamContainerLogs(log, "ea-agent");

        await pluginHost.startDaemons();
        log.info("plugin daemons started");

        let shuttingDown = false;
        const shutdown = async (signal: string) => {
            if (shuttingDown) {
                return;
            }
            shuttingDown = true;
            log.info({ signal }, "draining");

            await safeStop(log, "plugin host", () => pluginHost.close());
            await safeStop(log, "agent container", () => container.stop());
            await safeStop(log, "reverse proxy", () => reverseProxy.stop());
            await safeStop(log, "postgres", () => postgres.stop());
            stopContainerLogStream(containerLogStream);

            removePidFile(boot.pidFile);
            process.exit(0);
        };

        process.on("SIGTERM", () => {
            void shutdown("SIGTERM");
        });
        process.on("SIGINT", () => {
            void shutdown("SIGINT");
        });

        log.info({ pid: process.pid }, "daemon ready");

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
 * `data/logs/ea.YYYYMMDD.<n>.log` daily; retention is read from
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
        await rollingFileStream(boot.logsDir, retention),
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
        log.error({ container, err: err.message }, "docker logs stream error");
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
        log.error({ label, err: err instanceof Error ? err.message : String(err) }, "stop error");
    }
}

/** Ensure all directories the daemon and agent container expect are present. */
function ensureDirs(boot: ReturnType<typeof bootstrap>): void {
    mkdirSync(boot.workspaceDir, { recursive: true });
    mkdirSync(boot.logsDir, { recursive: true });
}

/** Write the current pid into the well-known pidfile for the stop command. */
function writePidFile(path: string): void {
    writeFileSync(path, `${process.pid}\n`, "utf-8");
}

/** Best-effort delete of the pidfile during shutdown. */
function removePidFile(path: string): void {
    try {
        unlinkSync(path);
    } catch {
        // ignore
    }
}
