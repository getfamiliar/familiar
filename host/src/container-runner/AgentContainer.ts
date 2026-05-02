import {
    SHARED_NETWORK_NAME,
    dockerExec,
    hostGatewayArgs,
    removeContainer,
    stopContainer,
} from "../DockerTools";
import { PROXY_BASE_URL } from "../proxy/AnthropicProxyManager";

const CONTAINER_NAME = "ea-agent";

/** Configuration for the single long-running agent container. */
export interface AgentContainerConfig {
    /** Docker image tag to run (e.g. `effective-agent`). */
    readonly imageName: string;
    /** Absolute host path to the data directory; mounted as workspace + ipc. */
    readonly dataPath: string;
    /** Postgres password forwarded to the agent as `POSTGRES_PASSWORD`. */
    readonly postgresPassword: string;
}

/**
 * Manages the single long-running agent container (`ea-agent`).
 *
 * Mounts:
 *   - {dataPath}/workspace → /workspace         (assistant memory)
 *   - {dataPath}/.claude   → /home/node/.claude (SDK session store, persists across restarts)
 *
 * Container joins `ea-net` so it can reach the `ea-anthropic-proxy`
 * container by hostname. The agent never sees the real
 * `ANTHROPIC_API_KEY` — it gets the placeholder `via-proxy`, satisfying
 * the SDK while routing all calls through the proxy.
 *
 * All host↔container communication flows through postgres events; there
 * is no file-based IPC channel.
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
        await removeContainer(CONTAINER_NAME);

        const workspaceDir = `${this.config.dataPath}/workspace`;
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
            "-e",
            `POSTGRES_PASSWORD=${this.config.postgresPassword}`,
            ...hostGatewayArgs(),
            "-v",
            `${workspaceDir}:/workspace`,
            "-v",
            `${claudeDir}:/home/node/.claude`,
            this.config.imageName,
        ];

        await dockerExec(args);
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

        await stopContainer(CONTAINER_NAME);
        await removeContainer(CONTAINER_NAME);

        this.running = false;
    }
}
