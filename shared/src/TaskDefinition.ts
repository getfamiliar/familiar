/** A task submitted to a context. Each task gets a unique ID. */
export interface TaskDefinition {
    readonly taskId: string;
    readonly prompt: string;
    readonly metadata?: Record<string, unknown>;
}
