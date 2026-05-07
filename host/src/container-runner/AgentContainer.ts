import {
    dockerExec,
    hostGatewayArgs,
    removeContainer,
    SHARED_NETWORK_NAME,
    stopContainer,
} from "../DockerTools.js";

const CONTAINER_NAME = "ea-agent";

/**
 * Placeholder API key handed to the agent container. The real LLM
 * provider keys live only on the host (in the bastion's ReverseProxy
 * module); the OpenAI-compatible client in the container needs *some*
 * string to send as `Authorization`, but the bastion strips it and
 * substitutes the real key. This value being readable from inside the
 * container is intentional — it grants no upstream access.
 */
const PLACEHOLDER_API_KEY = "via-bastion";

/** Configuration for the single long-running agent container. */
export interface AgentContainerConfig {
    /** Docker image tag to run (e.g. `effective-agent`). */
    readonly imageName: string;
    /** Absolute host path to the data directory; mounted as workspace. */
    readonly dataPath: string;
    /**
     * Absolute host path of `container/src/`. Bind-mounted (read-only)
     * over `/app/src` inside the container so the tsx-watch entrypoint
     * picks up source edits without an image rebuild.
     */
    readonly containerSrcPath: string;
    /** Postgres password forwarded to the agent as `POSTGRES_PASSWORD`. */
    readonly postgresPassword: string;
    /**
     * Base URL the agent should dial for everything privileged
     * (LLM proxying, MCP gateway). Resolved at daemon start as
     * `http://<ea-net-gateway-ip>:<port>`. The agent appends
     * `/llm/<provider>/v1` for inference and `/mcp/<id>` for tools.
     */
    readonly bastionUrl: string;
    /**
     * Provider id the agent uses by default for inference (e.g.
     * `featherless`). Combined with `bastionUrl` to form the LLM
     * client's base URL.
     */
    readonly inferenceProvider: string;
    /**
     * When true, the agent container runs at debug log level
     * (`EA_LOG_LEVEL=debug`). Mirrors the daemon's `--verbose` flag so
     * a single switch turns up detail across both processes.
     */
    readonly verbose: boolean;
}

/**
 * Manages the single long-running agent container (`ea-agent`).
 *
 * Mounts:
 *   - {dataPath}/workspace → /workspace (assistant memory)
 *   - {containerSrcPath} → /app/src (read-only, hot-reload via tsx watch)
 *
 * Container joins `ea-net` so it can reach `ea-postgres` by hostname.
 * All host↔container communication flows through the postgres `events`
 * table — no file-based IPC, no host-side reverse proxy.
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

        const args = [
            "run",
            "-d",
            "--name",
            CONTAINER_NAME,
            "--network",
            SHARED_NETWORK_NAME,
            // On Linux, `host.docker.internal` isn't built-in; map it to
            // the host gateway so the agent can reach the bastion.
            ...hostGatewayArgs(),
            "-e",
            `POSTGRES_PASSWORD=${this.config.postgresPassword}`,
            "-e",
            `BASTION_URL=${this.config.bastionUrl}`,
            "-e",
            `INFERENCE_PROVIDER=${this.config.inferenceProvider}`,
            "-e",
            `INFERENCE_API_KEY=${PLACEHOLDER_API_KEY}`,
            "-e",
            `EA_LOG_LEVEL=${this.config.verbose ? "debug" : "info"}`,
            "-v",
            `${workspaceDir}:/workspace`,
            "-v",
            `${this.config.containerSrcPath}:/app/src:ro`,
            this.config.imageName,
        ];

        await dockerExec(args);
        this.running = true;
    }

    /**
     * Stop and remove the agent container. SIGTERM-equivalent; the
     * container's worker loops catch the signal and drain any in-flight
     * work before exiting. Defaults to docker's 10 s grace period.
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
