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
    /** Postgres password forwarded to the agent as `POSTGRES_PASSWORD`. */
    readonly postgresPassword: string;
    /**
     * Base URL the agent should dial for everything privileged
     * (LLM proxying, MCP gateway). Post-lockdown this points at the
     * `familiar-bastion-bridge` socat sidecar
     * (`http://familiar-bastion-bridge:<port>`), which forwards to the
     * host bastion — the agent has no direct route to the host. The
     * agent appends `/llm/<provider>/` for inference and `/mcp/<id>`
     * for tools.
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
     * Maximum retry attempts on retryable inference errors when the
     * handler doesn't override `maxRetries` in its YAML frontmatter.
     * Reflected to the container as the `INFERENCE_MAX_RETRIES` env
     * var. Sourced from `inference.maxRetries` in `config.yml`,
     * defaulting to 3.
     */
    readonly inferenceMaxRetries: number;
    /**
     * Fraction (0–1) of a model's context window used as the per-step
     * output ceiling when the model's metadata declares no explicit
     * output limit. Reflected to the container as the
     * `INFERENCE_OUTPUT_FALLBACK_PERCENTAGE` env var. Sourced from
     * `inference.outputFallbackPercentage` in `config.yml`, defaulting
     * to 0.7.
     */
    readonly inferenceOutputFallbackPercentage: number;
    /**
     * Token cap for inline tool-call results before the runner spills
     * the full response to a scratch file. Used as the upper bound in the
     * model-relative offload threshold `min(0.25 * contextLimit, cap)`.
     * Reflected to the container as `TOOL_CALL_OFFLOADING_LIMIT`; sourced
     * from `core.toolCallOffloadingLimit` in `config.yml`, defaulting to
     * `DEFAULT_TOOL_CALL_OFFLOADING_LIMIT` (16000). Individual handlers
     * can override per-call via their `toolCallOffloadingLimit`
     * frontmatter field.
     */
    readonly toolCallOffloadingLimit: number;
    /**
     * Number of recent steps whose tool results survive context-window
     * eviction; older tool results are elided to a short placeholder.
     * Reflected to the container as
     * `INFERENCE_CONTEXT_KEPT_TOOL_RESULT_COUNT`; sourced from
     * `inference.contextManagement.keptToolResultCount`, defaulting to 3.
     */
    readonly inferenceKeptToolResultCount: number;
    /**
     * Fraction of the model's context window at which the agent loop
     * starts dropping the oldest messages. Reflected to the container as
     * `INFERENCE_CONTEXT_SLIDING_WINDOW_PERCENTAGE`; sourced from
     * `inference.contextManagement.slidingWindowPercentage`, clamped to
     * `(0.3, 1.0)` container-side, defaulting to 0.7.
     */
    readonly inferenceSlidingWindowPercentage: number;
    /**
     * Hard cap (in seconds) on a *single SDK step* of `agent.generate()`.
     * The Scheduler resets this timer on every completed step, so it
     * bounds the slowest step rather than the whole agentrun — catching
     * a wedged tool call or stuck model without penalising
     * long-but-healthy runs. Reflected to the container as
     * `AGENTSTEP_TIMEOUT_SECONDS`. Sourced from `core.agentStepTimeout`
     * in `config.yml`, defaulting to 150.
     */
    readonly agentStepTimeoutSeconds: number;
    /**
     * When `true`, AgentRunner JSON-serializes the full SDK step
     * result into `stepresults.raw_result`. Reflected to the
     * container as `INFERENCE_CAPTURE_RAW_STEP_RESULT=true|false`;
     * sourced from `inference.captureRawStepResultToDatabase` in
     * `config.yml`, defaulting to `false`.
     */
    readonly captureRawStepResultToDatabase: boolean;
    /**
     * When `true`, AgentRunner JSON-serializes the assembled initial
     * model-message array into `agentruns.initial_messages`. Reflected
     * to the container as
     * `INFERENCE_CAPTURE_INITIAL_MESSAGE_HISTORY=true|false`; sourced
     * from `inference.captureInitialMessageHistory` in `config.yml`,
     * defaulting to `false`.
     */
    readonly captureInitialMessageHistory: boolean;
    /**
     * Controls whether — and how — AgentRunner persists each agentrun's
     * resolved system prompt onto `agentruns.system_prompt`. Reflected
     * to the container as `INFERENCE_LOG_SYSTEM_PROMPT_MODE=off|full|non-static`;
     * sourced from `core.logSystemPrompt` in `config.yml` (accepting
     * booleans and the two mode strings — normalized by `Start.ts`).
     * Default: `"full"` in dev, `"off"` in prod.
     */
    readonly logSystemPromptMode: LogSystemPromptMode;
    /**
     * Map of enabled provider key → its SDK npm package (e.g.
     * `openai` → `@ai-sdk/openai`, `featherless` → `@ai-sdk/openai-compatible`).
     * Resolved by `Start.ts` from each provider's model metadata
     * (models.dev `npm` or a plugin descriptor). Forwarded as the
     * `INFERENCE_PROVIDERS` env var; the container's `ModelFactory`
     * selects the right `create*` function from the npm package and
     * validates handler-declared provider prefixes against the keys.
     */
    readonly providerNpmPackages: Readonly<Record<string, string>>;
    /**
     * When true, the agent container runs at debug log level
     * (`FAMILIAR_LOG_LEVEL=debug`). Mirrors the daemon's `--verbose` flag so
     * a single switch turns up detail across both processes.
     */
    readonly verbose: boolean;
    /**
     * Operator's preferred IANA timezone (`core.timezone` from
     * `config.yml`). Forwarded as `CORE_TIMEZONE` and consumed by
     * the system-prompt builder's "Current time" line. Empty string
     * → the container falls back to its system timezone.
     */
    readonly coreTimezone: string;
    /**
     * Workspace-relative globs from `core.writablePaths` (normalized to
     * a string list). Forwarded as `CORE_WRITABLE_PATHS` (JSON array)
     * and consumed by the container's fs tools and OS-permission
     * normalizer: a non-privileged run (and the bash tool's unprivileged
     * user) may write only paths matching any of these (plus `/scratch`).
     * Empty list → only privileged runs may write anywhere.
     */
    readonly writablePaths: readonly string[];
    /**
     * Pip requirements baked into the agent image's python venv
     * (`config.python.packages`, defaulting to {@link DEFAULT_PYTHON_PACKAGES}).
     * The SAME list passed to the image build-arg, forwarded as
     * `AGENT_PYTHON_PACKAGES` (JSON array) so the bash tool's runtime
     * help section can name the installed packages. Empty list → the
     * help section omits the package list.
     */
    readonly pythonPackages: readonly string[];
    /**
     * Host operator's uid/gid. Forwarded as `HOST_UID` / `HOST_GID`; the
     * entrypoint provisions the privileged `priv` user with this uid and
     * drops to it via gosu, so files the agent writes are host-owned (the
     * same uid:gid synchronization postgres and the MCP runtimes do via
     * docker `--user`). Read once at daemon boot from `process.getuid()` /
     * `process.getgid()` (see `Bootstrap.hostUid`).
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
        "-e",
        `POSTGRES_PASSWORD=${config.postgresPassword}`,
        "-e",
        `BASTION_URL=${config.bastionUrl}`,
        "-e",
        `INFERENCE_DEFAULT_PROVIDER=${config.defaultProvider}`,
        "-e",
        `INFERENCE_DEFAULT_MODEL=${config.defaultModel}`,
        "-e",
        `INFERENCE_PROVIDERS=${JSON.stringify(config.providerNpmPackages)}`,
        "-e",
        `INFERENCE_MAX_RETRIES=${config.inferenceMaxRetries}`,
        "-e",
        `INFERENCE_OUTPUT_FALLBACK_PERCENTAGE=${config.inferenceOutputFallbackPercentage}`,
        "-e",
        `TOOL_CALL_OFFLOADING_LIMIT=${config.toolCallOffloadingLimit}`,
        "-e",
        `INFERENCE_CONTEXT_KEPT_TOOL_RESULT_COUNT=${config.inferenceKeptToolResultCount}`,
        "-e",
        `INFERENCE_CONTEXT_SLIDING_WINDOW_PERCENTAGE=${config.inferenceSlidingWindowPercentage}`,
        "-e",
        `AGENTSTEP_TIMEOUT_SECONDS=${config.agentStepTimeoutSeconds}`,
        "-e",
        `INFERENCE_CAPTURE_RAW_STEP_RESULT=${config.captureRawStepResultToDatabase}`,
        "-e",
        `INFERENCE_CAPTURE_INITIAL_MESSAGE_HISTORY=${config.captureInitialMessageHistory}`,
        "-e",
        `INFERENCE_LOG_SYSTEM_PROMPT_MODE=${config.logSystemPromptMode}`,
        "-e",
        `CORE_TIMEZONE=${config.coreTimezone}`,
        "-e",
        `CORE_WRITABLE_PATHS=${JSON.stringify(config.writablePaths)}`,
        "-e",
        `AGENT_PYTHON_PACKAGES=${JSON.stringify(config.pythonPackages)}`,
        "-e",
        `HOST_UID=${config.hostUid}`,
        "-e",
        `HOST_GID=${config.hostGid}`,
        "-e",
        `FAMILIAR_LOG_LEVEL=${config.verbose ? "debug" : "info"}`,
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
