import {
    SHARED_NETWORK_NAME,
    dockerExec,
    isContainerRunning,
    removeContainer,
} from "../DockerTools";

const PROXY_CONTAINER_NAME = "ea-anthropic-proxy";
const PROXY_IMAGE_NAME = "effective-anthropic-proxy:latest";
const PROXY_PORT = 8788;

/** The DNS name agent containers use to reach the proxy. */
export const PROXY_HOSTNAME = PROXY_CONTAINER_NAME;

/** The TCP port the proxy listens on inside the docker network. */
export const PROXY_PORT_NUMBER = PROXY_PORT;

/** The base URL agent containers should use for ANTHROPIC_BASE_URL. */
export const PROXY_BASE_URL = `http://${PROXY_HOSTNAME}:${PROXY_PORT}`;

/**
 * Manages the lifecycle of the singleton Anthropic reverse-proxy
 * container. The proxy holds the real `ANTHROPIC_API_KEY`; agent
 * containers only ever see the placeholder `via-proxy` value, satisfying
 * the SDK's import-time check without granting real credentials.
 *
 * Network setup is the daemon's job (see `commands/Start.ts`); this
 * class assumes `SHARED_NETWORK_NAME` already exists when `ensureProxy`
 * is called.
 */
export class AnthropicProxyManager {
    private proxyEnsured = false;

    /**
     * Ensure the singleton proxy container is running and attached to the
     * shared network. Idempotent. Reads `ANTHROPIC_API_KEY` from the host
     * process environment and passes it to the proxy container.
     *
     * @throws If `ANTHROPIC_API_KEY` is not set on the host.
     */
    async ensureProxy(): Promise<void> {
        if (this.proxyEnsured) {
            return;
        }

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error(
                "ANTHROPIC_API_KEY is not set. Add it to .env at the repo root.",
            );
        }

        if (await isContainerRunning(PROXY_CONTAINER_NAME)) {
            this.proxyEnsured = true;
            return;
        }

        await removeContainer(PROXY_CONTAINER_NAME);

        await dockerExec([
            "run",
            "--rm",
            "-d",
            "--name",
            PROXY_CONTAINER_NAME,
            "--network",
            SHARED_NETWORK_NAME,
            "-e",
            `ANTHROPIC_API_KEY=${apiKey}`,
            "-e",
            `PORT=${PROXY_PORT}`,
            PROXY_IMAGE_NAME,
        ]);

        this.proxyEnsured = true;
    }

    /**
     * Stop the proxy container. Used by tests and graceful shutdown.
     * In normal operation the proxy is intentionally left running across
     * daemon restarts for cheap warm-up.
     */
    async teardown(): Promise<void> {
        await removeContainer(PROXY_CONTAINER_NAME);
        this.proxyEnsured = false;
    }
}
