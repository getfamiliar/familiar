import { spawn } from "node:child_process";

const PROXY_CONTAINER_NAME = "ea-anthropic-proxy";
const PROXY_IMAGE_NAME = "effective-anthropic-proxy:latest";
const PROXY_PORT = 8788;

/**
 * Build the Docker network name for a given context.
 *
 * @param contextId - The context identifier.
 * @returns The bridge network name (e.g. `ea-net-inbox`).
 */
export function networkNameForContext(contextId: string): string {
    return `ea-net-${contextId}`;
}

/** The DNS name agent containers use to reach the proxy. */
export const PROXY_HOSTNAME = PROXY_CONTAINER_NAME;

/** The TCP port the proxy listens on inside the docker network. */
export const PROXY_PORT_NUMBER = PROXY_PORT;

/** The base URL agent containers should use for ANTHROPIC_BASE_URL. */
export const PROXY_BASE_URL = `http://${PROXY_HOSTNAME}:${PROXY_PORT}`;

/**
 * Manages the lifecycle of the shared Anthropic reverse proxy container
 * and the per-context Docker bridge networks that agent containers join.
 *
 * The proxy is a singleton: started on first need, reused across every
 * context. It holds the real `ANTHROPIC_API_KEY`. Agent containers reach
 * it only via the per-context network, never via a published host port.
 */
export class AnthropicProxyManager {
    private proxyEnsured = false;
    private readonly attachedNetworks = new Set<string>();

    /**
     * Ensure the singleton proxy container is running. Idempotent: a no-op
     * after the first successful call. Reads `ANTHROPIC_API_KEY` from the
     * host process environment and passes it to the proxy container.
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

        if (await this.containerIsRunning(PROXY_CONTAINER_NAME)) {
            this.proxyEnsured = true;
            return;
        }

        // Remove any stopped container with the same name so `run --name` can succeed.
        await this.dockerExec(["rm", "-f", PROXY_CONTAINER_NAME], { allowFailure: true });

        await this.dockerExec([
            "run",
            "--rm",
            "-d",
            "--name",
            PROXY_CONTAINER_NAME,
            "-e",
            `ANTHROPIC_API_KEY=${apiKey}`,
            "-e",
            `PORT=${PROXY_PORT}`,
            PROXY_IMAGE_NAME,
        ]);

        this.proxyEnsured = true;
    }

    /**
     * Ensure a per-context bridge network exists and the proxy container is
     * attached to it. Idempotent: subsequent calls for the same context are
     * no-ops within a single host process lifetime.
     *
     * @param contextId - The context identifier.
     * @returns The network name that agent containers should join.
     */
    async attachToContextNetwork(contextId: string): Promise<string> {
        const networkName = networkNameForContext(contextId);

        if (this.attachedNetworks.has(networkName)) {
            return networkName;
        }

        if (!(await this.networkExists(networkName))) {
            await this.dockerExec(["network", "create", networkName]);
        }

        if (!(await this.proxyAttachedTo(networkName))) {
            await this.dockerExec(["network", "connect", networkName, PROXY_CONTAINER_NAME]);
        }

        this.attachedNetworks.add(networkName);
        return networkName;
    }

    /**
     * Stop the proxy container. Used by tests and graceful shutdown.
     * In production the proxy can outlive any single host invocation.
     */
    async teardown(): Promise<void> {
        await this.dockerExec(["rm", "-f", PROXY_CONTAINER_NAME], { allowFailure: true });
        this.proxyEnsured = false;
        this.attachedNetworks.clear();
    }

    /**
     * Check whether a container with the given name is currently running.
     *
     * @param name - The container name.
     * @returns True if the container exists and is running.
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

    /**
     * Check whether a Docker network with the given name already exists.
     *
     * @param name - The network name.
     */
    private async networkExists(name: string): Promise<boolean> {
        const { code } = await this.dockerCapture(["network", "inspect", name]);
        return code === 0;
    }

    /**
     * Check whether the proxy container is already attached to a given
     * network. Avoids `network connect` errors on repeat invocations.
     *
     * @param network - The network name to check.
     */
    private async proxyAttachedTo(network: string): Promise<boolean> {
        const { stdout, code } = await this.dockerCapture([
            "network",
            "inspect",
            "-f",
            "{{range $k, $v := .Containers}}{{$v.Name}}\n{{end}}",
            network,
        ]);
        if (code !== 0) {
            return false;
        }
        return stdout
            .split("\n")
            .map((line) => line.trim())
            .some((name) => name === PROXY_CONTAINER_NAME);
    }

    /**
     * Run a docker CLI command and discard output.
     *
     * @param args - Arguments to pass to `docker`.
     * @param options.allowFailure - If true, non-zero exit codes resolve instead of throwing.
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
     *
     * @param args - Arguments to pass to `docker`.
     * @returns The exit code and captured stdout.
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
