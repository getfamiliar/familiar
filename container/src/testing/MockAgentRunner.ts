import type { AgentRunRow } from "@getfamiliar/shared";
import type { AgentRunner, AgentRunnerContext } from "../agent-runner/AgentRunner.js";

/**
 * Behaviour callback for a {@link MockAgentRunner}. Tests supply one
 * closure per runner that, given the {@link AgentRunnerContext}, drives
 * the desired effects:
 *
 * - return a string → equivalent to a real handler returning its final text
 * - throw a {@link RetryableModelException} → triggers Scheduler postpone
 * - throw an {@link AgentRunTimeoutError} → settled as timeout failure
 * - throw any other Error → settled as a non-retryable failure
 * - spawn children (call_handler / schedule_handler immediate-mode shape) by calling
 *   `await ctx.tools.call_handler({...})` if the test wires `tools`,
 *   or — more simply — by INSERTing a child row directly through a
 *   bus reference the test captured at setup time and then
 *   `await ctx.waitForSubagent(child.id)` to suspend.
 */
export type MockBehavior = (ctx: AgentRunnerContext) => Promise<string>;

/**
 * Script-free, callback-driven mock {@link AgentRunner}. Tests
 * construct one (or a factory) with a behavior closure that decides
 * what happens when the Scheduler calls `run`.
 *
 * The mock is intentionally minimal — it does not parse YAML, build
 * tools, or talk to a model. Anything in the real runner that the
 * test cares about should be modeled inside the supplied behavior.
 *
 * Not typed as `implements AgentRunner` because the production class
 * has no exported method-only interface; the structural shape
 * (`run(ctx): Promise<string>`) is what callers depend on, and
 * factory functions returning either work in places typed as
 * `AgentRunner` due to TypeScript's structural compat on
 * field-less classes.
 */
export class MockAgentRunner {
    constructor(private readonly behavior: MockBehavior) {}

    async run(ctx: AgentRunnerContext): Promise<string> {
        return this.behavior(ctx);
    }
}

/**
 * Convenience: build a runner factory that picks a behavior by the
 * row's `handler` basename. Returns a default behavior (throws) when
 * a row arrives with an unregistered handler so the test fails loud.
 */
export function buildRunnerFactory(
    behaviors: Record<string, MockBehavior>,
): (row: AgentRunRow) => AgentRunner {
    return (row: AgentRunRow): AgentRunner => {
        const behavior = behaviors[row.handler];
        if (!behavior) {
            throw new Error(
                `MockAgentRunner: no behavior registered for handler "${row.handler}" (row ${row.id})`,
            );
        }
        return new MockAgentRunner(behavior) as unknown as AgentRunner;
    };
}
