import {
    dockerExec,
    hostGatewayArgs,
    removeContainer,
    SHARED_NETWORK_NAME,
    stopContainer,
} from "../DockerTools.js";

const CONTAINER_NAME = "ea-agent";

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
     * `/llm/<provider>/` for inference and `/mcp/<id>` for tools.
     */
    readonly bastionUrl: string;
    /**
     * Provider id the agent uses when a handler doesn't put a provider
     * prefix on its `model` field (e.g. `featherless` so a bare
     * `zai-org/GLM-5.1` resolves to that client).
     */
    readonly defaultProvider: string;
    /**
     * Default model id used when a handler omits `model` from its
     * frontmatter. Resolved on the container side under `defaultProvider`.
     */
    readonly defaultModel: string;
    /**
     * Map of enabled provider id → SDK type. Native ids (`openai`,
     * `anthropic`, `grok`, …) map to themselves; custom ids declared
     * under `inference.customProviders` map to `"openai-compatible"`.
     * The container's `ModelFactory` switches on this to instantiate
     * the right Vercel AI SDK client and validates handler-declared
     * provider prefixes against it.
     */
    readonly providerTypes: Readonly<Record<string, string>>;
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
            `INFERENCE_DEFAULT_PROVIDER=${this.config.defaultProvider}`,
            "-e",
            `INFERENCE_DEFAULT_MODEL=${this.config.defaultModel}`,
            "-e",
            `INFERENCE_PROVIDERS=${JSON.stringify(this.config.providerTypes)}`,
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
