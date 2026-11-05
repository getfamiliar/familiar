import type { Logger } from "@getfamiliar/shared";
import type { ModelMessage } from "ai";
import type { ContextManager } from "./ContextManager.js";
import { buildStepBudgetNotice } from "./stepBudgetNotice.js";

/** The subset of the SDK's `prepareStep` options {@link buildStepMessages} reads. */
export interface StepMessagesInput {
    /** 0-indexed number of the step about to execute. */
    readonly stepNumber: number;
    /** The messages passed into `agent.generate()`. */
    readonly initialMessages: ReadonlyArray<ModelMessage>;
    /** The response messages accumulated over all previous steps. */
    readonly responseMessages: ReadonlyArray<ModelMessage>;
}

/** Collaborators {@link buildStepMessages} needs from the runner. */
export interface StepMessagesDeps {
    /** The run's context-window manager. */
    readonly contextManager: Pick<ContextManager, "prepare" | "buildRepeatedCallNotice">;
    /** The per-run step cap. */
    readonly maxSteps: number;
    /** Per-run logger. */
    readonly log: Logger;
}

/**
 * Build the message array for the next tool-loop step: the context-managed
 * history plus ephemeral notices (repeated call, remaining step budget).
 *
 * Since AI SDK 7, `messages` returned from `prepareStep` carry forward into
 * the next step's `messages`. Feeding those back in would stack the notices
 * step after step and run the context manager over an already-rewritten
 * history. So the history is rebuilt from the SDK's untouched
 * `initialMessages` + `responseMessages` on every step, which keeps the
 * notices ephemeral and the duplicate/repeated-call detection working on the
 * real conversation.
 *
 * @param input The step number and the unmanaged history from `prepareStep`.
 * @param deps The run's context manager, step cap and logger.
 * @returns The messages to send to the model for this step.
 */
export async function buildStepMessages(
    input: StepMessagesInput,
    deps: StepMessagesDeps,
): Promise<ModelMessage[]> {
    const history: ModelMessage[] = [...input.initialMessages, ...input.responseMessages];
    const managed = await deps.contextManager.prepare(history);
    // Appended after context management so the sliding window can never
    // evict them.
    const repeatedCallNotice = deps.contextManager.buildRepeatedCallNotice(history);
    const budgetNotice = buildStepBudgetNotice(input.stepNumber, deps.maxSteps);
    const notices = [repeatedCallNotice, budgetNotice].filter(
        (notice): notice is string => notice !== null,
    );
    deps.log.debug(
        {
            stepNumber: input.stepNumber,
            messageCount: history.length,
            managedMessageCount: managed.length,
            repeatedCallNotice,
            budgetNotice,
        },
        `step ${input.stepNumber} starting with ${managed.length} of ${history.length} messages`,
    );
    return [...managed, ...notices.map((content): ModelMessage => ({ role: "user", content }))];
}
