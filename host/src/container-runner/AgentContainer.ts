import { resolve } from "node:path";
import type { Logger } from "@getfamiliar/shared";
import {
    dockerExec,
    hostGatewayArgs,
    removeContainer,
    SHARED_NETWORK_NAME,
    stopContainer,
} from "../DockerTools.js";

const CONTAINER_NAME = "familiar-agent";

/**
 * Image tag for the long-running agent container. Built from
 * `container/Dockerfile` on demand by {@link ensureAgentImage}.
 */
export const AGENT_IMAGE_TAG = "familiar-agent";

/**
 * Build the agent container image if it isn't already up to date with
 * its Dockerfile. Idempotent — docker's layer cache makes the
 * no-change case fast, so calling this on every daemon start is cheap
 * and fresh checkouts don't need a separate manual build step.
 * Mirrors {@link ensureRuntimeImage} for MCP runtimes.
 */
export async function ensureAgentImage(log: Logger): Promise<void> {
    // host/build/container-runner/AgentContainer.js lives three levels
    // under the project root.
    const projectRoot = resolve(import.meta.dirname, "../../..");
    const dockerfile = `${projectRoot}/container/Dockerfile`;
    log.info(`building ${AGENT_IMAGE_TAG} from ${dockerfile}`);
    await dockerExec(["build", "-t", AGENT_IMAGE_TAG, "-f", dockerfile, projectRoot]);
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
     * (LLM proxying, MCP gateway). Resolved at daemon start as
     * `http://<familiar-net-gateway-ip>:<port>`. The agent appends
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
     * Maximum retry attempts on retryable inference errors when the
     * handler doesn't override `maxRetries` in its YAML frontmatter.
     * Reflected to the container as the `INFERENCE_MAX_RETRIES` env
     * var. Sourced from `inference.maxRetries` in `config.yml`,
     * defaulting to 3.
     */
    readonly inferenceMaxRetries: number;
    /**
     * Byte budget for inline tool-call results before the runner spills
     * the full response to a scratch file. Reflected to the container
     * as `TOOL_CALL_OFFLOADING_LIMIT`; sourced from
     * `core.toolCallOffloadingLimit` in `config.yml`, defaulting to
     * `DEFAULT_TOOL_CALL_OFFLOADING_LIMIT` (10000). Individual handlers
     * can override per-call via their `toolCallOffloadingLimit`
     * frontmatter field.
     */
    readonly toolCallOffloadingLimit: number;
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
     * When `true`, AgentRunner persists each agentrun's resolved
     * system prompt onto `agentruns.system_prompt`. Reflected to
     * the container as `INFERENCE_LOG_SYSTEM_PROMPT=true|false`;
     * sourced from `core.logSystemPrompt` in `config.yml`,
     * defaulting to `false`.
     */
    readonly logSystemPrompt: boolean;
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
     * and consumed by the container's fs tools: a non-privileged run
     * may write paths matching any of these, bypassing the `.md` /
     * `toolgroups/` privilege gate. Empty list → strict gate (only
     * privileged runs write `.md`).
     */
    readonly writablePaths: readonly string[];
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
 * Container joins `familiar-net` so it can reach `familiar-postgres` by hostname.
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
            `INFERENCE_MAX_RETRIES=${this.config.inferenceMaxRetries}`,
            "-e",
            `TOOL_CALL_OFFLOADING_LIMIT=${this.config.toolCallOffloadingLimit}`,
            "-e",
            `AGENTSTEP_TIMEOUT_SECONDS=${this.config.agentStepTimeoutSeconds}`,
            "-e",
            `INFERENCE_CAPTURE_RAW_STEP_RESULT=${this.config.captureRawStepResultToDatabase}`,
            "-e",
            `INFERENCE_LOG_SYSTEM_PROMPT=${this.config.logSystemPrompt}`,
            "-e",
            `CORE_TIMEZONE=${this.config.coreTimezone}`,
            "-e",
            `CORE_WRITABLE_PATHS=${JSON.stringify(this.config.writablePaths)}`,
            "-e",
            `FAMILIAR_LOG_LEVEL=${this.config.verbose ? "debug" : "info"}`,
            "-v",
            `${workspaceDir}:/workspace`,
            "-v",
            `${this.config.containerSrcPath}:/app/src:ro`,
            "-v",
            `${this.config.sharedBuildPath}:/shared/build:ro`,
            "-v",
            `${this.config.scratchPath}:/scratch`,
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
