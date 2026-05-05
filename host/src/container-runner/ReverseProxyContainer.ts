import { dockerExec, removeContainer, SHARED_NETWORK_NAME, stopContainer } from "../DockerTools.js";

const CONTAINER_NAME = "ea-reverse-proxy";

/** Configuration for the singleton reverse-proxy container. */
export interface ReverseProxyContainerConfig {
    /** Docker image tag to run (e.g. `ea-reverse-proxy`). */
    readonly imageName: string;
    /** Upstream base URL the proxy forwards to (e.g. `https://api.featherless.ai`). */
    readonly upstreamBase: string;
    /** Real API key the proxy injects on outbound requests. Never seen by the agent container. */
    readonly upstreamApiKey: string;
}

/**
 * Manages the single long-running reverse-proxy container (`ea-reverse-proxy`).
 *
 * Joins `ea-net` so the agent container can reach it by hostname. Not
 * port-published — the proxy is only addressable from inside the Docker
 * network, which is the only access boundary protecting the upstream API
 * key.
 */
export class ReverseProxyContainer {
    private readonly config: ReverseProxyContainerConfig;
    private running = false;

    constructor(config: ReverseProxyContainerConfig) {
        this.config = config;
    }

    /** True if `start()` has succeeded and `stop()` has not yet been called. */
    get isRunning(): boolean {
        return this.running;
    }

    /**
     * Start the proxy detached. Removes any previous container with the
     * same name first so this is safe to call after a crash.
     */
    async start(): Promise<void> {
        await removeContainer(CONTAINER_NAME);

        const args = [
            "run",
            "-d",
            "--name",
            CONTAINER_NAME,
            "--network",
            SHARED_NETWORK_NAME,
            "-e",
            `UPSTREAM_BASE=${this.config.upstreamBase}`,
            "-e",
            `UPSTREAM_API_KEY=${this.config.upstreamApiKey}`,
            this.config.imageName,
        ];

        await dockerExec(args);
        this.running = true;
    }

    /**
     * Stop and remove the proxy container. SIGTERM-equivalent; the proxy
     * drains in-flight forwards before exiting. Defaults to docker's 10 s
     * grace period.
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
