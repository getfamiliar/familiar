/**
 * Thrown by {@link AgentRunner.run} when the agent's tool loop hit its
 * hard step budget (`MAX_STEPS_PER_RUN`) before the model produced a
 * final reply.
 *
 * The budget is enforced through the AI SDK's
 * `stopWhen: stepCountIs(MAX_STEPS_PER_RUN)`, which is a *stop
 * condition* rather than an error — `agent.generate()` resolves
 * normally when it fires. The runner detects the cut-off (aggregate
 * `finishReason === "tool-calls"`: the model still wanted to call tools
 * when the loop stopped) and throws this typed error so the
 * {@link AgentrunScheduler} settles the row `failed` with a clear
 * message instead of silently marking a truncated run `done`.
 *
 * This is an expected safety outcome (a runaway-loop guard), not a
 * crash — the Scheduler logs it at `warn`, mirroring
 * {@link AgentRunTimeoutError}.
 */
export class StepLimitReachedError extends Error {
    /** Number of steps the agent actually took before being stopped. */
    readonly stepCount: number;
    /** The configured per-run step cap that was reached. */
    readonly maxSteps: number;

    /**
     * @param stepCount Steps the agent took before the loop was stopped.
     * @param maxSteps The configured per-run step cap.
     */
    constructor(stepCount: number, maxSteps: number) {
        super(
            `The agent reached its step limit of ${maxSteps} tool-call steps and was stopped ` +
                "before it could finish. This usually means the handler looped on tool calls " +
                "without converging; simplify the task or raise the step budget.",
        );
        this.name = "StepLimitReachedError";
        this.stepCount = stepCount;
        this.maxSteps = maxSteps;
    }
}
