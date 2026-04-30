/** A context defines a task environment — one container runs per context. */
export interface ContextConfig {
    readonly contextId: string;
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
