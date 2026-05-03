import { dockerExec, removeContainer, SHARED_NETWORK_NAME, stopContainer } from "../DockerTools";

const CONTAINER_NAME = "ea-agent";

/**
 * Placeholder API key handed to the agent container. The real Featherless
 * key lives only in the reverse proxy; the OpenAI-compatible client in the
 * container needs *some* string to send as `Authorization`, but the proxy
 * strips it and substitutes the real key. This value being readable from
 * inside the container is intentional — it grants no upstream access.
 */
const PLACEHOLDER_API_KEY = "via-proxy";

/** Configuration for the single long-running agent container. */
export interface AgentContainerConfig {
    /** Docker image tag to run (e.g. `effective-agent`). */
    readonly imageName: string;
    /** Absolute host path to the data directory; mounted as workspace. */
    readonly dataPath: string;
    /** Postgres password forwarded to the agent as `POSTGRES_PASSWORD`. */
    readonly postgresPassword: string;
    /**
     * Base URL the agent's LLM client should hit, e.g.
     * `http://ea-reverse-proxy:8788/v1`. Resolved on the shared Docker
     * network; the agent never reaches the real provider directly.
     */
    readonly featherlessBaseUrl: string;
}

/**
 * Manages the single long-running agent container (`ea-agent`).
 *
 * Mounts:
 *   - {dataPath}/workspace → /workspace (assistant memory)
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
            "-e",
            `POSTGRES_PASSWORD=${this.config.postgresPassword}`,
            "-e",
            `FEATHERLESS_BASE_URL=${this.config.featherlessBaseUrl}`,
            "-e",
            `FEATHERLESS_API_KEY=${PLACEHOLDER_API_KEY}`,
            "-v",
            `${workspaceDir}:/workspace`,
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
