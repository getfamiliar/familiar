/** The result JSON written by the container for a completed task. */
export interface ContainerOutput {
    readonly taskId: string;
    readonly sessionId: string;
    readonly output: unknown;
}
