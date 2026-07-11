import { spawn, spawnSync } from "node:child_process";
import os from "node:os";

/**
 * Shared bridge network all Familiar containers join. Owned
 * by the daemon (see `commands/Start.ts`); created once via
 * {@link ensureNetwork} before any container is started.
 */
export const SHARED_NETWORK_NAME = "familiar-net";

/**
 * Internal (egress-less) bridge network the locked-down agent container
 * joins. Created with `--internal` so the agent has no route to the
 * internet; it reaches postgres (dual-homed onto this net) and the host
 * bastion (via the `familiar-bastion-bridge` socat sidecar, also on this
 * net) by container name. Owned by the daemon, created via
 * {@link ensureNetwork} with `{ internal: true }`.
 */
export const ISOLATED_NETWORK_NAME = "familiar-isolated";

/** Options shared by {@link dockerExec}. */
export interface DockerExecOptions {
    /** If true, non-zero exit codes resolve instead of throwing. */
    readonly allowFailure?: boolean;
}

/** Output of {@link dockerCapture}. */
export interface DockerCaptureResult {
    readonly code: number | null;
    readonly stdout: string;
}

/**
 * Run a docker CLI command and discard its stdio. Resolves on exit
 * code 0 (or always when `allowFailure` is set); rejects otherwise.
 */
export function dockerExec(
    args: readonly string[],
    options: DockerExecOptions = {},
): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn("docker", [...args], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        proc.on("close", (code) => {
            if (code === 0 || options.allowFailure) {
                resolve();
                return;
            }
            const trimmed = stderr.trim();
            const suffix = trimmed.length > 0 ? `: ${trimmed}` : "";
            reject(new Error(`docker ${args.join(" ")} exited with code ${code}${suffix}`));
        });
        proc.on("error", reject);
    });
}

/**
 * Run a docker CLI command and capture stdout. Never throws on non-zero
 * exit; callers inspect the returned `code`.
 */
export function dockerCapture(args: readonly string[]): Promise<DockerCaptureResult> {
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

/** Whether a container with the given name is currently running. */
export async function isContainerRunning(name: string): Promise<boolean> {
    const { code, stdout } = await dockerCapture([
        "container",
        "inspect",
        "-f",
        "{{.State.Running}}",
        name,
    ]);
    return code === 0 && stdout.trim() === "true";
}

/** Whether a Docker network with the given name already exists. */
export async function isNetworkPresent(name: string): Promise<boolean> {
    const { code } = await dockerCapture(["network", "inspect", name]);
    return code === 0;
}

/**
 * Whether a Docker image with the given reference is present in the
 * local image store. Used by the pull-mode image lifecycle to avoid
 * re-pulling a version-pinned image that's already local.
 *
 * @param ref Image reference (tag or registry-qualified `name:tag`).
 * @returns true if `docker image inspect` succeeds.
 */
export async function isImagePresent(ref: string): Promise<boolean> {
    const { code } = await dockerCapture(["image", "inspect", ref]);
    return code === 0;
}

/** Options for {@link buildNetworkCreateArgs} / {@link ensureNetwork}. */
export interface NetworkCreateOptions {
    /**
     * Create the network with `--internal` so containers on it have no
     * egress to the host or the internet — only to other containers on
     * the same network. Used for the agent's `familiar-isolated` net.
     */
    readonly internal?: boolean;
}

/**
 * Build the `docker network create` argument vector. Pure (no side
 * effects) so it can be unit-tested without a daemon.
 *
 * @param name Network name to create.
 * @param options Network creation flags (e.g. `internal`).
 * @returns The full docker CLI argv, e.g. `["network", "create", "--internal", "familiar-isolated"]`.
 */
export function buildNetworkCreateArgs(name: string, options: NetworkCreateOptions = {}): string[] {
    const args = ["network", "create"];
    if (options.internal) {
        args.push("--internal");
    }
    args.push(name);
    return args;
}

/**
 * Create the named bridge network if it doesn't already exist. Idempotent.
 *
 * @param name Network name to ensure.
 * @param options Network creation flags applied only on first creation
 *   (an existing network is left as-is).
 */
export async function ensureNetwork(
    name: string,
    options: NetworkCreateOptions = {},
): Promise<void> {
    if (!(await isNetworkPresent(name))) {
        await dockerExec(buildNetworkCreateArgs(name, options));
    }
}

/**
 * Attach an already-running container to an additional network by name.
 * Callers recreate their container on every `start()` (via
 * {@link removeContainer} first), so the attachment is always fresh —
 * this throws on failure rather than swallowing it, so a genuine
 * problem (missing network, missing container) surfaces instead of
 * silently leaving the container unable to reach its peer.
 *
 * @param network Network to connect the container to.
 * @param container Name of the running container to attach.
 * @throws If the docker command fails (network/container missing, etc.).
 */
export function connectNetwork(network: string, container: string): Promise<void> {
    return dockerExec(["network", "connect", network, container]);
}

/**
 * Force-remove a container by name. Default `allowFailure: true` because
 * "remove if it exists" is the common idempotent-cleanup intent.
 */
export function removeContainer(
    name: string,
    options: DockerExecOptions = { allowFailure: true },
): Promise<void> {
    return dockerExec(["rm", "-f", name], options);
}

/** Send `docker stop` to a container. Ignores already-stopped/missing containers. */
export function stopContainer(name: string): Promise<void> {
    return dockerExec(["stop", name], { allowFailure: true });
}

/**
 * Run a docker CLI command with the parent process's stdin/stdout/
 * stderr inherited, blocking until the child exits. Used by
 * subcommands that hand the user's terminal to a foreground docker
 * process (`./cli.sh psql`'s psql shell, `./cli.sh mcp call`'s
 * one-shot CLI invocations against an MCP runtime container).
 *
 * Returns the child's exit status — `null`-on-signal collapses to
 * 1 so the caller's `process.exit(...)` always sees a usable
 * number. A failure to launch docker itself (e.g. binary missing)
 * surfaces as a thrown {@link Error} the caller can format.
 *
 * @throws If the docker binary couldn't be spawned at all.
 */
export function dockerInteractive(args: readonly string[]): number {
    const result = spawnSync("docker", [...args], { stdio: "inherit" });
    if (result.error) {
        throw new Error(`failed to launch docker: ${result.error.message}`);
    }
    return result.status ?? 1;
}

/**
 * On Linux, `host.docker.internal` isn't built-in and must be mapped to
 * the host gateway explicitly. macOS and Windows resolve it natively.
 *
 * Currently unused but kept available — the Featherless integration
 * (next step) will likely route via a host-side helper that the agent
 * container reaches over `host.docker.internal`.
 *
 * @returns Extra `docker run` args, or an empty array on macOS/Windows.
 */
export function hostGatewayArgs(): string[] {
    if (os.platform() === "linux") {
        return ["--add-host=host.docker.internal:host-gateway"];
    }
    return [];
}
