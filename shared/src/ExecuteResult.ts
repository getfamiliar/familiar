/** The result of executing a prompt via the agent SDK. */
export interface ExecuteResult {
    readonly sessionId: string;
    readonly result: string;
}
