import { randomBytes } from "node:crypto";
import type { ContainerOutput, TaskDefinition } from "effective-assistant-shared";
import { AnthropicProxyManager } from "../proxy/AnthropicProxyManager";
import { ContainerInstance } from "./ContainerInstance";
import type { ContainerConfig, ContainerState, ContextConfig } from "./Types";

const TASK_ID_LENGTH = 8;
const TASK_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate a short alphanumeric task ID.
 *
 * @returns An 8-character lowercase alphanumeric string.
 */
function generateTaskId(): string {
    const bytes = randomBytes(TASK_ID_LENGTH);
    let id = "";
    for (let i = 0; i < TASK_ID_LENGTH; i++) {
        id += TASK_ID_CHARS[bytes[i] % TASK_ID_CHARS.length];
    }
    return id;
}

/** Status snapshot of a single container in the pool. */
export interface ContainerStatus {
    readonly contextId: string;
    readonly state: ContainerState;
}

/**
 * Manages a pool of Docker containers, one per context.
 * Routes tasks to existing containers or spawns new ones as needed.
 * Tracks session IDs per context for session resumption across container restarts.
 */
export class ContainerPool {
    private readonly config: ContainerConfig;
    private readonly proxyManager = new AnthropicProxyManager();
    private readonly containers = new Map<string, ContainerInstance>();
    private readonly sessions = new Map<string, string>();

    constructor(config: ContainerConfig) {
        this.config = config;
    }

    /**
     * Submit a task to a context. If a container is already running for the
     * context, the task is sent via IPC. Otherwise a new container is started
     * with any previously known session ID for that context.
     *
     * @param context - The context configuration (determines which container to use).
     * @param prompt - The task prompt.
     * @param metadata - Optional metadata attached to the task.
     * @returns The output produced by the container for this task.
     */
    async submitTask(
        context: ContextConfig,
        prompt: string,
        metadata?: Record<string, unknown>,
    ): Promise<ContainerOutput> {
        const task: TaskDefinition = {
            taskId: generateTaskId(),
            prompt,
            metadata,
        };

        const existing = this.containers.get(context.contextId);

        if (existing && existing.state === "running") {
            const output = await existing.sendTask(task);
            this.sessions.set(context.contextId, output.sessionId);
            return output;
        }

        return this.startContainer(context, task);
    }

    /**
     * Stop and remove the container for a specific context.
     *
     * @param contextId - The context whose container should be stopped.
     */
    async stopContext(contextId: string): Promise<void> {
        const instance = this.containers.get(contextId);
        if (!instance) {
            return;
        }

        await instance.stop();
        this.containers.delete(contextId);
    }

    /**
     * Stop all running containers. Use for graceful host shutdown.
     */
    async stopAll(): Promise<void> {
        const stops = Array.from(this.containers.values()).map((instance) => instance.stop());
        await Promise.all(stops);
        this.containers.clear();
    }

    /**
     * Get the current status of all containers in the pool.
     *
     * @returns A map of context ID to container status.
     */
    getStatus(): Map<string, ContainerStatus> {
        const status = new Map<string, ContainerStatus>();
        for (const [contextId, instance] of this.containers) {
            status.set(contextId, {
                contextId,
                state: instance.state,
            });
        }
        return status;
    }

    /**
     * Get the known session ID for a context, if any.
     *
     * @param contextId - The context to look up.
     * @returns The session ID, or undefined if no session has been established.
     */
    getSessionId(contextId: string): string | undefined {
        return this.sessions.get(contextId);
    }

    /**
     * Create a new ContainerInstance, register it in the pool, and start it
     * with the given task. Passes any known session ID for the context.
     *
     * @param context - The context configuration for the new container.
     * @param task - The initial task to execute.
     * @returns The output produced by the container for this task.
     */
    private async startContainer(
        context: ContextConfig,
        task: TaskDefinition,
    ): Promise<ContainerOutput> {
        const instance = new ContainerInstance(this.config, context, this.proxyManager);

        instance.onExit = () => {
            this.containers.delete(context.contextId);
        };

        this.containers.set(context.contextId, instance);

        const sessionId = this.sessions.get(context.contextId);
        const output = await instance.start(task, sessionId);
        this.sessions.set(context.contextId, output.sessionId);

        return output;
    }
}
