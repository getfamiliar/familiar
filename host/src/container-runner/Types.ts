/** A context defines a task environment — one container runs per context. */
export interface ContextConfig {
    readonly contextId: string;
    readonly mcpTools?: string[];
}

/** A task submitted to a context. Each task gets a unique ID. */
export interface TaskDefinition {
    readonly taskId: string;
    readonly prompt: string;
    readonly metadata?: Record<string, unknown>;
}

/** The result returned by the container for a completed task. */
export interface TaskResult {
    readonly taskId: string;
    readonly output: unknown;
}

/** The JSON payload piped to a container's stdin on first start. */
export interface ContainerStartPayload {
    readonly contextId: string;
    readonly mcpTools?: string[];
    readonly task: TaskDefinition;
}

/** Configuration for spawning containers. */
export interface ContainerConfig {
    readonly imageName: string;
    readonly dataPath: string;
    readonly timeoutMs: number;
    readonly dockerArgs?: string[];
}

/** Lifecycle states of a container instance. */
export type ContainerState = "starting" | "running" | "stopping" | "stopped" | "error";
