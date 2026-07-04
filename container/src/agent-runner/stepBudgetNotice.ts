/**
 * Per-step "how many steps do you have left" notice injected into the
 * agent's message history as it nears the hard step budget
 * (`MAX_STEPS_PER_RUN`). Without this the agent has no idea the cap
 * exists — it plans as if it had unlimited turns and gets cut off
 * mid-work with no chance to produce a final answer.
 *
 * The notice is built fresh every step (in {@link AgentRunner}'s
 * `prepareStep` hook) so the remaining-step count is always live, and
 * it is ephemeral — the SDK applies `prepareStep`'s messages only to
 * the current step, so nothing is persisted into the conversation.
 */

/** Remaining-step threshold at or below which the countdown notice is injected. */
export const STEP_BUDGET_WARNING_THRESHOLD = 3;

/**
 * Notice injected on the agent's final permitted step, replacing the
 * countdown. Forces a final answer instead of another tool call.
 */
export const LAST_TURN_NOTICE =
    "This is your last turn, you MUST produce the final output in this turn!";

/**
 * Build the per-step budget notice, or `null` when the agent still has
 * comfortable runway.
 *
 * `stepNumber` is the SDK's 0-indexed completed-step count for the step
 * about to run; `stepsRemaining = maxSteps - stepNumber` (e.g. `15` on
 * the first step of a 15-step cap, `1` on the last).
 *
 * @param stepNumber 0-indexed number of the step about to execute.
 * @param maxSteps The configured per-run step cap.
 * @returns The {@link LAST_TURN_NOTICE} on the last step, a countdown
 *   string when {@link STEP_BUDGET_WARNING_THRESHOLD} or fewer steps
 *   remain, otherwise `null`.
 */
export function buildStepBudgetNotice(stepNumber: number, maxSteps: number): string | null {
    const remaining = maxSteps - stepNumber;
    if (remaining <= 1) {
        return LAST_TURN_NOTICE;
    }
    if (remaining <= STEP_BUDGET_WARNING_THRESHOLD) {
        return `You have only ${remaining} steps left before you will be stopped. Start wrapping up and prepare to produce your final output.`;
    }
    return null;
}
