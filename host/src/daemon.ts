import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentContainer } from "./container-runner/AgentContainer";
import { AnthropicProxyManager } from "./proxy/AnthropicProxyManager";

const DATA_DIR = resolve(__dirname, "../../data");
const PID_FILE = `${DATA_DIR}/.daemon.pid`;
const WORKSPACE_DIR = `${DATA_DIR}/workspace`;
const IPC_INPUT_DIR = `${DATA_DIR}/ipc/input`;
const IPC_OUTPUT_DIR = `${DATA_DIR}/ipc/output`;
const CLAUDE_DIR = `${DATA_DIR}/.claude`;

/**
 * Host daemon: keeps the proxy and the single agent container running,
 * and tears them down cleanly on SIGTERM/SIGINT. The host has no role in
 * the per-task IPC path; the chat CLI talks to the container directly via
 * the shared `data/ipc/` directory.
 */
async function main(): Promise<void> {
    ensureDirs();
    writePidFile();

    const proxy = new AnthropicProxyManager();
    const container = new AgentContainer({
        imageName: "effective-agent",
        dataPath: DATA_DIR,
    });

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
        console.error(`Received ${signal}, stopping agent container…`);
        try {
            await container.stop();
        } catch (err) {
            console.error(
                `Container stop error: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
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

/** Ensure all directories the daemon and container expect are present. */
function ensureDirs(): void {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    mkdirSync(IPC_INPUT_DIR, { recursive: true });
    mkdirSync(IPC_OUTPUT_DIR, { recursive: true });
    mkdirSync(CLAUDE_DIR, { recursive: true });
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

main().catch((err) => {
    console.error("Daemon fatal:", err instanceof Error ? err.message : err);
    removePidFile();
    process.exit(1);
});
