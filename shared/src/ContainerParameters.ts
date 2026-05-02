import type { TaskDefinition } from "./TaskDefinition";

/**
 * Per-task input file written by the host (or the chat CLI) and consumed
 * by the agent container's task loop. Lives at `/ipc/input/{taskId}.json`.
 */
export interface ContainerParameters {
    readonly sessionId?: string;
    readonly task: TaskDefinition;
}
