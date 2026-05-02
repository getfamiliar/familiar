import { spawn } from "node:child_process";

const PROXY_CONTAINER_NAME = "ea-anthropic-proxy";
const PROXY_IMAGE_NAME = "effective-anthropic-proxy:latest";
const PROXY_PORT = 8788;
const SHARED_NETWORK = "ea-net";

/** Docker network shared by the proxy and the agent container. */
export const SHARED_NETWORK_NAME = SHARED_NETWORK;

/** The DNS name agent containers use to reach the proxy. */
export const PROXY_HOSTNAME = PROXY_CONTAINER_NAME;

/** The TCP port the proxy listens on inside the docker network. */
export const PROXY_PORT_NUMBER = PROXY_PORT;

/** The base URL agent containers should use for ANTHROPIC_BASE_URL. */
export const PROXY_BASE_URL = `http://${PROXY_HOSTNAME}:${PROXY_PORT}`;

/**
 * Manages the lifecycle of the singleton Anthropic reverse-proxy container
 * and the shared `ea-net` bridge network that both the proxy and the agent
 * container join. The proxy holds the real `ANTHROPIC_API_KEY`; the agent
 * container only ever sees the placeholder `via-proxy` value, satisfying
 * the SDK's import-time check without granting real credentials.
 */
export class AnthropicProxyManager {
    private proxyEnsured = false;
    private networkEnsured = false;

    /**
     * Ensure the shared bridge network exists.
     */
    async ensureNetwork(): Promise<string> {
        if (this.networkEnsured) {
            return SHARED_NETWORK;
        }

        if (!(await this.networkExists(SHARED_NETWORK))) {
            await this.dockerExec(["network", "create", SHARED_NETWORK]);
        }

        this.networkEnsured = true;
        return SHARED_NETWORK;
    }

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

        await this.ensureNetwork();

        if (await this.containerIsRunning(PROXY_CONTAINER_NAME)) {
            this.proxyEnsured = true;
            return;
        }

        await this.dockerExec(["rm", "-f", PROXY_CONTAINER_NAME], { allowFailure: true });

        await this.dockerExec([
            "run",
            "--rm",
            "-d",
            "--name",
            PROXY_CONTAINER_NAME,
            "--network",
            SHARED_NETWORK,
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
     * In production the proxy can outlive any single host invocation.
     */
    async teardown(): Promise<void> {
        await this.dockerExec(["rm", "-f", PROXY_CONTAINER_NAME], { allowFailure: true });
        this.proxyEnsured = false;
    }

    /**
     * Check whether a container with the given name is currently running.
     */
    private async containerIsRunning(name: string): Promise<boolean> {
        const { stdout, code } = await this.dockerCapture([
            "container",
            "inspect",
            "-f",
            "{{.State.Running}}",
            name,
        ]);
        return code === 0 && stdout.trim() === "true";
    }

    /** Check whether a Docker network with the given name already exists. */
    private async networkExists(name: string): Promise<boolean> {
        const { code } = await this.dockerCapture(["network", "inspect", name]);
        return code === 0;
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

    /**
     * Run a docker CLI command and capture stdout. Never throws on non-zero
     * exit; callers inspect the returned `code`.
     */
    private dockerCapture(
        args: readonly string[],
    ): Promise<{ readonly code: number | null; readonly stdout: string }> {
        return new Promise((resolve, reject) => {
            const proc = spawn("docker", [...args], { stdio: ["ignore", "pipe", "ignore"] });
            let stdout = "";
            proc.stdout.on("data", (chunk: Buffer) => {
                stdout += chunk.toString();
            });
            proc.on("close", (code) => {
                resolve({ code, stdout });
            });
            proc.on("error", reject);
        });
    }
}
