import { spawn, spawnSync } from "node:child_process";
import os from "node:os";

/**
 * Shared bridge network all effective-assistant containers join. Owned
 * by the daemon (see `commands/Start.ts`); created once via
 * {@link ensureNetwork} before any container is started.
 */
export const SHARED_NETWORK_NAME = "ea-net";

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
 * Create the named bridge network if it doesn't already exist. Idempotent.
 */
export async function ensureNetwork(name: string): Promise<void> {
    if (!(await isNetworkPresent(name))) {
        await dockerExec(["network", "create", name]);
    }
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
