import { spawn } from "node:child_process";
import os from "node:os";
import { PROXY_BASE_URL, SHARED_NETWORK_NAME } from "../proxy/AnthropicProxyManager";

const CONTAINER_NAME = "ea-agent";

/** Configuration for the single long-running agent container. */
export interface AgentContainerConfig {
    /** Docker image tag to run (e.g. `effective-agent`). */
    readonly imageName: string;
    /** Absolute host path to the data directory; mounted as workspace + ipc. */
    readonly dataPath: string;
}

/**
 * Manages the single long-running agent container (`ea-agent`).
 *
 * Mounts:
 *   - {dataPath}/workspace → /workspace         (assistant memory, .last-session)
 *   - {dataPath}/ipc       → /ipc               (per-task input/output files)
 *   - {dataPath}/.claude   → /home/node/.claude (SDK session store, persists across restarts)
 *
 * Container joins `ea-net` so it can reach the `ea-anthropic-proxy`
 * container by hostname. The agent never sees the real
 * `ANTHROPIC_API_KEY` — it gets the placeholder `via-proxy`, satisfying
 * the SDK while routing all calls through the proxy.
 */
export class AgentContainer {
    private readonly config: AgentContainerConfig;
    private running = false;

    constructor(config: AgentContainerConfig) {
        this.config = config;
    }

    /** True if `start()` has succeeded and `stop()` has not yet been called. */
    get isRunning(): boolean {
        return this.running;
    }

    /**
     * Start the agent container detached. Removes any previous container
     * with the same name first so this is safe to call after a crash.
     */
    async start(): Promise<void> {
        await this.dockerExec(["rm", "-f", CONTAINER_NAME], { allowFailure: true });

        const workspaceDir = `${this.config.dataPath}/workspace`;
        const ipcDir = `${this.config.dataPath}/ipc`;
        const claudeDir = `${this.config.dataPath}/.claude`;

        const args = [
            "run",
            "-d",
            "--name",
            CONTAINER_NAME,
            "--network",
            SHARED_NETWORK_NAME,
            "-e",
            `ANTHROPIC_BASE_URL=${PROXY_BASE_URL}`,
            "-e",
            "ANTHROPIC_API_KEY=via-proxy",
            ...this.hostGatewayArgs(),
            "-v",
            `${workspaceDir}:/workspace`,
            "-v",
            `${ipcDir}:/ipc`,
            "-v",
            `${claudeDir}:/home/node/.claude`,
            this.config.imageName,
        ];

        await this.dockerExec(args);
        this.running = true;
    }

    /**
     * Stop and remove the agent container. SIGTERM-equivalent; the
     * container's TaskLoop catches the signal and drains any in-flight
     * task before exiting. Defaults to docker's 10 s grace period.
     */
    async stop(): Promise<void> {
        if (!this.running) {
            return;
        }

        try {
            await this.dockerExec(["stop", CONTAINER_NAME]);
        } catch {
            // already gone
        }
        try {
            await this.dockerExec(["rm", "-f", CONTAINER_NAME]);
        } catch {
            // already removed
        }

        this.running = false;
    }

    /**
     * On Linux, host.docker.internal isn't built-in and must be mapped to
     * the host gateway explicitly. macOS and Windows resolve it natively.
     */
    private hostGatewayArgs(): string[] {
        if (os.platform() === "linux") {
            return ["--add-host=host.docker.internal:host-gateway"];
        }
        return [];
    }

    /**
     * Run a docker CLI command and discard output.
     */
    private dockerExec(
        args: readonly string[],
        options: { allowFailure?: boolean } = {},
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = spawn("docker", [...args], { stdio: "ignore" });
            proc.on("close", (code) => {
                if (code === 0 || options.allowFailure) {
                    resolve();
                } else {
                    reject(new Error(`docker ${args.join(" ")} exited with code ${code}`));
                }
            });
            proc.on("error", reject);
        });
    }
}
