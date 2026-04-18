import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
    ContainerOutput,
    ContainerParameters,
    TaskDefinition,
} from "effective-assistant-shared";
import type { ContainerConfig, ContainerState, ContextConfig } from "./Types";

/**
 * Represents a single running Docker container bound to a context.
 * Manages the full lifecycle: start, send follow-up tasks via IPC, and stop.
 */
export class ContainerInstance {
    readonly contextId: string;

    private readonly config: ContainerConfig;
    private readonly context: ContextConfig;
    private containerId: string | undefined;
    private _state: ContainerState = "stopped";
    private timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    private _onExit: ((code: number | null) => void) | undefined;

    constructor(config: ContainerConfig, context: ContextConfig) {
        this.config = config;
        this.context = context;
        this.contextId = context.contextId;
    }

    /**
     * Host path to this context's data directory.
     */
    private get contextDir(): string {
        return join(this.config.dataPath, `context-${this.contextId}`);
    }

    /** Current lifecycle state of the container. */
    get state(): ContainerState {
        return this._state;
    }

    /** Register a callback invoked when the container process exits. */
    set onExit(handler: (code: number | null) => void) {
        this._onExit = handler;
    }

    /**
     * Spawn the Docker container and pipe the initial task as JSON via stdin.
     * Resolves with the container output once the container writes the result file.
     *
     * @param task - The first task to execute in this container.
     * @param sessionId - Optional session ID to resume a previous session.
     * @returns The output written by the container for this task.
     */
    async start(task: TaskDefinition, sessionId?: string): Promise<ContainerOutput> {
        this._state = "starting";

        await this.ensureDirectories();

        const resultPromise = this.waitForResult(task.taskId);

        const params: ContainerParameters = {
            contextId: this.context.contextId,
            sessionId,
            mcpTools: this.context.mcpTools,
            task,
        };

        const args = this.buildDockerArgs();
        const proc = spawn("docker", args, { stdio: ["pipe", "inherit", "inherit"] });

        proc.stdin.write(`${JSON.stringify(params)}\n`);
        proc.stdin.end();

        this.containerId = await this.captureContainerId(proc);
        this._state = "running";
        this.resetTimeout();

        proc.on("close", (code) => {
            if (this._state !== "stopping") {
                this._state = "stopped";
            }
            this.clearTimeout();
            this._onExit?.(code);
        });

        return resultPromise;
    }

    /**
     * Send a follow-up task to the running container via an IPC file.
     * The container already has the session from startup.
     * Resets the idle timeout and waits for the container to write a result file.
     *
     * @param task - The task to send to the container.
     * @returns The output written by the container for this task.
     * @throws If the container is not in the "running" state.
     */
    async sendTask(task: TaskDefinition): Promise<ContainerOutput> {
        if (this._state !== "running") {
            throw new Error(`Cannot send task to container in state "${this._state}"`);
        }

        this.resetTimeout();

        const inputPath = join(this.contextDir, "ipc", "input", `${task.taskId}.json`);
        await writeFile(inputPath, JSON.stringify(task), "utf-8");

        return this.waitForResult(task.taskId);
    }

    /**
     * Stop and remove the Docker container.
     */
    async stop(): Promise<void> {
        if (this._state === "stopped" || this._state === "stopping") {
            return;
        }

        this._state = "stopping";
        this.clearTimeout();

        if (this.containerId) {
            try {
                await this.dockerExec(["stop", this.containerId]);
            } catch {
                // Container may have already exited (e.g. --rm)
            }
            try {
                await this.dockerExec(["rm", "-f", this.containerId]);
            } catch {
                // Already removed
            }
        }

        this._state = "stopped";
    }

    /**
     * Build the `docker run` argument list from the config.
     * Mounts data directories into the container's /workspace/:
     * - data/global/           → /workspace/global/
     * - data/context-{id}/     → /workspace/context/
     * - data/context-{id}/.claude/ → /workspace/.claude/
     *
     * @returns The argument array for child_process.spawn.
     */
    private buildDockerArgs(): string[] {
        const globalDir = join(this.config.dataPath, "global");
        const claudeDir = join(this.contextDir, ".claude");

        const args = [
            "run",
            "--rm",
            "-i",
            "-v",
            `${globalDir}:/workspace/global`,
            "-v",
            `${this.contextDir}:/workspace/context`,
            "-v",
            `${claudeDir}:/workspace/.claude`,
            ...(this.config.dockerArgs ?? []),
            this.config.imageName,
        ];
        return args;
    }

    /**
     * Read the container ID from the docker process stdout.
     * For `docker run`, the container ID isn't printed unless using -d.
     * We use `docker ps` with a label filter instead, or capture from the process.
     *
     * @param proc - The spawned docker process.
     * @returns The container ID string.
     */
    private captureContainerId(proc: ReturnType<typeof spawn>): Promise<string> {
        return new Promise((resolve) => {
            // With --rm -i the container ID isn't printed to stdout.
            // Use the process PID as a fallback identifier until we can query docker.
            resolve(`pid-${proc.pid}`);
        });
    }

    /**
     * Ensure all required host directories exist before starting a container.
     * Creates the global dir, context dir, .claude dir, and IPC directories.
     */
    private async ensureDirectories(): Promise<void> {
        await mkdir(join(this.config.dataPath, "global"), { recursive: true });
        await mkdir(join(this.contextDir, ".claude"), { recursive: true });
        await mkdir(join(this.contextDir, "ipc", "input"), { recursive: true });
        await mkdir(join(this.contextDir, "ipc", "tasks"), { recursive: true });
    }

    /**
     * Poll for a task result file and resolve with its parsed contents.
     * Uses polling instead of fs.watch for reliability across platforms
     * and Docker volume mounts (especially WSL2).
     *
     * @param taskId - The task ID to watch for.
     * @returns The parsed ContainerOutput from the result file.
     */
    private async waitForResult(taskId: string): Promise<ContainerOutput> {
        const resultPath = join(this.contextDir, "ipc", "tasks", `${taskId}.result.json`);
        const pollIntervalMs = 200;
        const maxWaitMs = this.config.timeoutMs;
        const deadline = Date.now() + maxWaitMs;

        while (Date.now() < deadline) {
            try {
                await access(resultPath);
                const content = await readFile(resultPath, "utf-8");
                return JSON.parse(content) as ContainerOutput;
            } catch {
                await new Promise((r) => setTimeout(r, pollIntervalMs));
            }
        }

        throw new Error(`Timed out waiting for result of task ${taskId}`);
    }

    /**
     * Reset the idle timeout. Called after every task submission.
     */
    private resetTimeout(): void {
        this.clearTimeout();
        this.timeoutHandle = setTimeout(() => {
            this.stop();
        }, this.config.timeoutMs);
    }

    /**
     * Clear the idle timeout if one is active.
     */
    private clearTimeout(): void {
        if (this.timeoutHandle) {
            globalThis.clearTimeout(this.timeoutHandle);
            this.timeoutHandle = undefined;
        }
    }

    /**
     * Execute a docker CLI command and wait for it to complete.
     *
     * @param args - Arguments to pass to the docker command.
     * @returns A promise that resolves when the command exits.
     */
    private dockerExec(args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const proc = spawn("docker", args, { stdio: "ignore" });
            proc.on("close", (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`docker ${args.join(" ")} exited with code ${code}`));
                }
            });
            proc.on("error", reject);
        });
    }
}
