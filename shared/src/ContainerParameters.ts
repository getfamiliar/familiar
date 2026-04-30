import type { TaskDefinition } from "./TaskDefinition";

/** The JSON payload piped to a container's stdin on start. */
export interface ContainerParameters {
    readonly contextId: string;
    readonly sessionId?: string;
    readonly task: TaskDefinition;
}
