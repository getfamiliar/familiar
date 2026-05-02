import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentContainer } from "./container-runner/AgentContainer";
import { PostgresContainer } from "./db/PostgresContainer";
import { AnthropicProxyManager } from "./proxy/AnthropicProxyManager";

const DATA_DIR = resolve(__dirname, "../../data");
const PID_FILE = `${DATA_DIR}/.daemon.pid`;
const POSTGRES_PORT_FILE = `${DATA_DIR}/.postgres-port`;
const WORKSPACE_DIR = `${DATA_DIR}/workspace`;
const IPC_INPUT_DIR = `${DATA_DIR}/ipc/input`;
const IPC_OUTPUT_DIR = `${DATA_DIR}/ipc/output`;
const CLAUDE_DIR = `${DATA_DIR}/.claude`;
const POSTGRES_DATA_DIR = `${DATA_DIR}/postgres`;

/**
 * Host daemon: brings up the bus-state postgres, the anthropic proxy,
 * and the long-running agent container, then waits for SIGTERM/SIGINT
 * to drain everything cleanly. The host has no role in per-task IPC —
 * the chat CLI talks to the agent directly via `data/ipc/`.
 *
 * Start order:   ea-net  →  postgres  →  proxy  →  agent
 * Stop order:    agent   →  proxy     →  postgres
 */
async function main(): Promise<void> {
    ensureDirs();
    writePidFile();

    const proxy = new AnthropicProxyManager();
    const postgres = new PostgresContainer({ dataPath: DATA_DIR });
    const container = new AgentContainer({
        imageName: "effective-agent",
        dataPath: DATA_DIR,
    });

    await proxy.ensureNetwork();
    console.error("ensured network ea-net");

    const postgresPort = await postgres.start();
    writeFileSync(POSTGRES_PORT_FILE, `${postgresPort}\n`, "utf-8");
    console.error(`postgres ready on 127.0.0.1:${postgresPort}`);

    await proxy.ensureProxy();
    console.error("anthropic-proxy ready");

    await container.start();
    console.error(`agent container started: ${container.isRunning ? "ea-agent" : "(failed)"}`);

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        console.error(`Received ${signal}, draining…`);

        await safeStop("agent container", () => container.stop());
        // Proxy is intentionally left running across daemon restarts for
        // cheap warm-up; uncomment if/when that changes.
        // await safeStop("anthropic-proxy", () => proxy.teardown());
        await safeStop("postgres", () => postgres.stop());

        removePostgresPortFile();
        removePidFile();
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
    const keepalive = setInterval(() => {}, 60_000);

    await new Promise<void>(() => {});
    // Unreachable, but quiets the unused-variable lint if any.
    clearInterval(keepalive);
}

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

/** Ensure all directories the daemon and container expect are present. */
function ensureDirs(): void {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    mkdirSync(IPC_INPUT_DIR, { recursive: true });
    mkdirSync(IPC_OUTPUT_DIR, { recursive: true });
    mkdirSync(CLAUDE_DIR, { recursive: true });
    mkdirSync(POSTGRES_DATA_DIR, { recursive: true });
}

/** Write the current pid into the well-known pidfile for cli/stop.sh. */
function writePidFile(): void {
    writeFileSync(PID_FILE, `${process.pid}\n`, "utf-8");
}

/** Best-effort delete of the pidfile during shutdown. */
function removePidFile(): void {
    try {
        unlinkSync(PID_FILE);
    } catch {
        // ignore
    }
}

/** Best-effort delete of the postgres port file during shutdown. */
function removePostgresPortFile(): void {
    try {
        unlinkSync(POSTGRES_PORT_FILE);
    } catch {
        // ignore
    }
}

main().catch((err) => {
    console.error("Daemon fatal:", err instanceof Error ? err.message : err);
    removePostgresPortFile();
    removePidFile();
    process.exit(1);
});
