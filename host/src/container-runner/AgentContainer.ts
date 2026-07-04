import { resolve } from "node:path";
import type { Logger } from "@getfamiliar/shared";
import {
    dockerExec,
    ISOLATED_NETWORK_NAME,
    removeContainer,
    stopContainer,
} from "../DockerTools.js";
import { isSafePipRequirement } from "./PythonPackages.js";

const CONTAINER_NAME = "familiar-agent";

/**
 * Tri-state mode for `core.logSystemPrompt`:
 *
 * - `"off"` — don't stamp `agentruns.system_prompt`.
 * - `"full"` — stamp the prompt verbatim.
 * - `"non-static"` — stamp the prompt with SOUL.md / CONTEXT.md
 *   replaced by `<content of file …>` placeholders so the audit log
 *   keeps per-run signal without the framing-file noise.
 *
 * Forwarded to the container as the string env var
 * `INFERENCE_LOG_SYSTEM_PROMPT_MODE`.
 */
export type LogSystemPromptMode = "off" | "full" | "non-static";

/**
 * Image tag for the long-running agent container. Built from
 * `container/Dockerfile` on demand by {@link ensureAgentImage}.
 */
export const AGENT_IMAGE_TAG = "familiar-agent";

/**
 * Default Python packages baked into the agent image when
 * `python.packages` is absent from config. Common data / document /
 * parsing libraries the bash tool's `python` interpreter is expected to
 * reach (the container is offline, so nothing can be added at runtime).
 */
export const DEFAULT_PYTHON_PACKAGES: readonly string[] = [
    "numpy",
    "pandas",
    "scipy",
    "sympy",
    "pillow",
    "matplotlib",
    "openpyxl",
    "python-docx",
    "pypdf",
    "python-pptx",
    "lxml",
    "beautifulsoup4",
    "markdown",
    "pyyaml",
    "ics",
];

/**
 * Validate pip requirements and join them into the space-separated value
 * for the `PYTHON_PACKAGES` build-arg.
 *
 * @param packages Requirement strings from `config.python.packages`.
 * @returns The validated, space-joined build-arg value (possibly empty).
 * @throws If any entry contains anything but a plain pip requirement.
 */
export function buildPythonPackagesArg(packages: readonly string[]): string {
    for (const pkg of packages) {
        if (!isSafePipRequirement(pkg)) {
            throw new Error(
                `Invalid python.packages entry ${JSON.stringify(pkg)}: must be a plain pip ` +
                    "requirement (name, optional [extras], optional version specifier) with no " +
                    "shell metacharacters or whitespace",
            );
        }
    }
    return packages.join(" ");
}

/**
 * Build the `docker build` argv for the agent image. Pure (no side
 * effects) so it can be unit-tested without invoking docker.
 *
 * @param dockerfile Absolute path to the Dockerfile.
 * @param context Build context directory (the project root).
 * @param pythonPackages Pip requirements for the `PYTHON_PACKAGES` build-arg.
 * @returns The docker CLI argv (without the leading `docker`).
 */
export function buildAgentImageArgs(
    dockerfile: string,
    context: string,
    pythonPackages: readonly string[],
): string[] {
    return [
        "build",
        "-t",
        AGENT_IMAGE_TAG,
        "-f",
        dockerfile,
        "--build-arg",
        `PYTHON_PACKAGES=${buildPythonPackagesArg(pythonPackages)}`,
        context,
    ];
}

/**
 * Build the agent container image if it isn't already up to date with
 * its Dockerfile. Idempotent — docker's layer cache makes the
 * no-change case fast, so calling this on every daemon start is cheap
 * and fresh checkouts don't need a separate manual build step.
 * Mirrors {@link ensureRuntimeImage} for MCP runtimes.
 *
 * @param log Logger.
 * @param pythonPackages Pip requirements baked into the image's venv;
 *   defaults to {@link DEFAULT_PYTHON_PACKAGES}.
 */
export async function ensureAgentImage(
    log: Logger,
    pythonPackages: readonly string[] = DEFAULT_PYTHON_PACKAGES,
): Promise<void> {
    // host/build/container-runner/AgentContainer.js lives three levels
    // under the project root.
    const projectRoot = resolve(import.meta.dirname, "../../..");
    const dockerfile = `${projectRoot}/container/Dockerfile`;
    log.info(`building ${AGENT_IMAGE_TAG} from ${dockerfile}`);
    await dockerExec(buildAgentImageArgs(dockerfile, projectRoot, pythonPackages));
}

/** Configuration for the single long-running agent container. */
export interface AgentContainerConfig {
    /** Docker image tag to run (e.g. `familiar-agent`). */
    readonly imageName: string;
    /** Absolute host path to the data directory; mounted as workspace. */
    readonly dataPath: string;
    /**
     * Absolute host path of `container/src/`. Bind-mounted (read-only)
     * over `/app/src` inside the container so the tsx-watch entrypoint
     * picks up source edits without an image rebuild.
     */
    readonly containerSrcPath: string;
    /**
     * Absolute host path of `shared/build/`. Bind-mounted (read-only)
     * over `/shared/build` so the container resolves
     * `@getfamiliar/shared` against the host's just-rebuilt
     * artifacts. The host (`cli.sh`) refreshes this directory before
     * the daemon starts, so it's always fresh by the time the
     * container boots — shared edits no longer need a container
     * image rebuild, only a daemon restart.
     */
    readonly sharedBuildPath: string;
    /**
     * Absolute host path of `tmp/scratch/`. Bind-mounted at
     * `/scratch/` inside the container (read-write) so the agent can
     * read per-event auxiliary files staged by `ctx.events.emit({
     * files: [...] })` using normal file tools, and pass the same
     * absolute paths to MCPs that have the same mount.
     */
    readonly scratchPath: string;
    /**
     * The flat config map the container reads via its `PassedConfig`
     * accessor, serialized to JSON and forwarded as the single
     * `FAMILIAR_CONTAINER_CONFIG` env var. Built host-side by
     * {@link ../container-runner/ContainerConfig.ContainerConfig} — it
     * carries every value the container's Node code needs (postgres
     * password, bastion URL, inference knobs, log level, timezone, …),
     * replacing the former long list of discrete `-e KEY=VALUE` flags.
     */
    readonly containerConfigJson: string;
    /**
     * Workspace-relative globs from `core.writablePaths` (normalized to
     * a string list). Forwarded as the discrete `CORE_WRITABLE_PATHS`
     * (JSON array) env var — separate from the JSON blob because the
     * shell `entrypoint.sh` reads it directly (before Node) to write the
     * permission normalizer's config. The container's Node code reads the
     * same value out of the passed config blob instead. Empty list → only
     * privileged runs may write anywhere.
     */
    readonly writablePaths: readonly string[];
    /**
     * Host operator's uid/gid. Forwarded as the discrete `HOST_UID` /
     * `HOST_GID` env vars (read by the shell `entrypoint.sh`, before Node,
     * so they can't ride in the JSON blob); the entrypoint provisions the
     * privileged `priv` user with this uid and drops to it via gosu, so
     * files the agent writes are host-owned. Read once at daemon boot from
     * `process.getuid()` / `process.getgid()` (see `Bootstrap.hostUid`).
     */
    readonly hostUid: number;
    readonly hostGid: number;
}

/**
 * Manages the single long-running agent container (`familiar-agent`).
 *
 * Mounts:
 *   - {dataPath}/workspace → /workspace (assistant memory)
 *   - {containerSrcPath} → /app/src (read-only, hot-reload via tsx watch)
 *   - {sharedBuildPath} → /shared/build (read-only, fresh per cli.sh rebuild)
 *   - {scratchPath} → /scratch (read-write, shared with every MCP)
 *
 * Container joins the egress-less `familiar-isolated` network only: it
 * can reach `familiar-postgres` (dual-homed onto that net) and the
 * `familiar-bastion-bridge` socat sidecar by hostname, but has no route
 * to the host or the internet. This is a deliberate lockdown ahead of
 * giving the agent shell access — it cannot exfiltrate via raw sockets,
 * scripts, or DNS. All host↔container communication flows through the
 * postgres `events` table and the bastion (via the bridge) — no
 * file-based IPC.
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
        await dockerExec(buildAgentRunArgs(this.config));
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

/**
 * Build the `docker run` argument vector for the agent container. Pure
 * (no side effects) so it can be unit-tested without a daemon.
 *
 * Security-critical invariant: the agent joins **only** the egress-less
 * `familiar-isolated` network — no `familiar-net`, no
 * `--add-host=host.docker.internal:host-gateway`. It reaches postgres and
 * the bastion bridge by container name via Docker's embedded resolver;
 * external names don't resolve and external hosts aren't routable. Don't
 * add `--dns` or `host.docker.internal` here without revisiting the
 * lockdown (and its unit test in `AgentContainer.test.ts`).
 *
 * @param config The agent container configuration.
 * @returns The full docker CLI argv.
 */
export function buildAgentRunArgs(config: AgentContainerConfig): string[] {
    const workspaceDir = `${config.dataPath}/workspace`;
    return [
        "run",
        "-d",
        "--name",
        CONTAINER_NAME,
        "--network",
        ISOLATED_NETWORK_NAME,
        // Everything the container's Node code reads rides in this one JSON
        // blob (see ContainerConfig / the container's PassedConfig). The
        // remaining discrete env vars below are consumed by the shell
        // entrypoint.sh *before* Node, so they can't live in the blob.
        "-e",
        `FAMILIAR_CONTAINER_CONFIG=${config.containerConfigJson}`,
        "-e",
        `CORE_WRITABLE_PATHS=${JSON.stringify(config.writablePaths)}`,
        "-e",
        `HOST_UID=${config.hostUid}`,
        "-e",
        `HOST_GID=${config.hostGid}`,
        "-v",
        `${workspaceDir}:/workspace`,
        "-v",
        `${config.containerSrcPath}:/app/src:ro`,
        "-v",
        `${config.sharedBuildPath}:/shared/build:ro`,
        "-v",
        `${config.scratchPath}:/scratch`,
        config.imageName,
    ];
}
