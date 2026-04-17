import { randomUUID } from "node:crypto";
import { ContainerInstance } from "./ContainerInstance.js";
import type {
    ContainerConfig,
    ContainerState,
    ContextConfig,
    TaskDefinition,
    TaskResult,
} from "./Types.js";

/** Status snapshot of a single container in the pool. */
export interface ContainerStatus {
    readonly contextId: string;
    readonly state: ContainerState;
}

/**
 * Manages a pool of Docker containers, one per context.
 * Routes tasks to existing containers or spawns new ones as needed.
 */
export class ContainerPool {
    private readonly config: ContainerConfig;
    private readonly containers = new Map<string, ContainerInstance>();

    constructor(config: ContainerConfig) {
        this.config = config;
    }

    /**
     * Submit a task to a context. If a container is already running for the
     * context, the task is sent via IPC. Otherwise a new container is started.
     *
     * @param context - The context configuration (determines which container to use).
     * @param prompt - The task prompt.
     * @param metadata - Optional metadata attached to the task.
     * @returns The result produced by the container for this task.
     */
    async submitTask(
        context: ContextConfig,
        prompt: string,
        metadata?: Record<string, unknown>,
    ): Promise<TaskResult> {
        const task: TaskDefinition = {
            taskId: randomUUID(),
            prompt,
            metadata,
        };

        const existing = this.containers.get(context.contextId);

        if (existing && existing.state === "running") {
            return existing.sendTask(task);
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
     * Create a new ContainerInstance, register it in the pool, and start it
     * with the given task.
     *
     * @param context - The context configuration for the new container.
     * @param task - The initial task to execute.
     * @returns The result produced by the container for this task.
     */
    private async startContainer(
        context: ContextConfig,
        task: TaskDefinition,
    ): Promise<TaskResult> {
        const instance = new ContainerInstance(this.config, context);

        instance.onExit = () => {
            this.containers.delete(context.contextId);
        };

        this.containers.set(context.contextId, instance);

        return instance.start(task);
    }
}
