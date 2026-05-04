import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { defineCommand } from "citty";
import { EventBus } from "effective-assistant-shared";
import { bootstrap } from "../Bootstrap";
import { AgentContainer } from "../container-runner/AgentContainer";
import { ReverseProxyContainer } from "../container-runner/ReverseProxyContainer";
import { ensureNetwork, SHARED_NETWORK_NAME } from "../DockerTools";
import { PostgresContainer } from "../db/PostgresContainer";
import { PluginHost } from "../plugins/PluginHost";

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
    async run() {
        const boot = bootstrap();
        const postgresPassword = boot.requireEnv("POSTGRES_PASSWORD");
        const featherlessApiKey = boot.requireEnv("FEATHERLESS_API_KEY");
        // Validated at startup so the daemon fails fast; the actual
        // value is read lazily via `boot.requireEnv` from inside
        // `HostContextImpl` when chat events are stamped.
        boot.requireEnv("DEFAULT_CHAT_CHANNEL_ID");

        ensureDirs(boot);
        writePidFile(boot.pidFile);

        const pluginHost = new PluginHost(boot);
        pluginHost.installWorkspaceTemplates();
        console.error("plugin workspace templates installed");

        const postgres = new PostgresContainer({
            dataPath: boot.dataDir,
            portFilePath: boot.postgresPortFile,
            password: postgresPassword,
        });
        const reverseProxy = new ReverseProxyContainer({
            imageName: "ea-reverse-proxy",
            upstreamBase: FEATHERLESS_UPSTREAM_BASE,
            upstreamApiKey: featherlessApiKey,
        });
        const container = new AgentContainer({
            imageName: "effective-agent",
            dataPath: boot.dataDir,
            postgresPassword,
            featherlessBaseUrl: FEATHERLESS_BASE_URL_FOR_AGENT,
        });

        await ensureNetwork(SHARED_NETWORK_NAME);
        console.error(`ensured network ${SHARED_NETWORK_NAME}`);

        const postgresPort = await postgres.start();
        console.error(`postgres ready on 127.0.0.1:${postgresPort}`);

        const schemaConnection = postgres.getConnection();
        try {
            const bus = new EventBus(schemaConnection);
            await bus.installSchema();
            console.error("bus-state schema installed");
        } finally {
            await schemaConnection.close();
        }

        await reverseProxy.start();
        console.error(
            `reverse proxy started: ${reverseProxy.isRunning ? "ea-reverse-proxy" : "(failed)"}`,
        );

        await container.start();
        console.error(`agent container started: ${container.isRunning ? "ea-agent" : "(failed)"}`);

        await pluginHost.startDaemons();
        console.error("plugin daemons started");

        let shuttingDown = false;
        const shutdown = async (signal: string) => {
            if (shuttingDown) {
                return;
            }
            shuttingDown = true;
            console.error(`Received ${signal}, draining…`);

            await safeStop("plugin host", () => pluginHost.close());
            await safeStop("agent container", () => container.stop());
            await safeStop("reverse proxy", () => reverseProxy.stop());
            await safeStop("postgres", () => postgres.stop());

            removePidFile(boot.pidFile);
            process.exit(0);
        };

        process.on("SIGTERM", () => {
            void shutdown("SIGTERM");
        });
        process.on("SIGINT", () => {
            void shutdown("SIGINT");
        });

        console.error(`daemon pid ${process.pid} ready`);

        // Keep the event loop alive until a signal arrives. A no-op interval
        // is the simplest portable handle; signal handlers alone don't pin
        // the loop in Node.
        setInterval(() => {}, 60_000);

        await new Promise<void>(() => {});
    },
});

/**
 * Run a stop step and log any error without aborting the rest of the
 * shutdown sequence. We want every component to get a chance to clean up.
 */
async function safeStop(label: string, stop: () => Promise<void>): Promise<void> {
    try {
        await stop();
    } catch (err) {
        console.error(`${label} stop error: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** Ensure all directories the daemon and agent container expect are present. */
function ensureDirs(boot: ReturnType<typeof bootstrap>): void {
    mkdirSync(boot.workspaceDir, { recursive: true });
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
