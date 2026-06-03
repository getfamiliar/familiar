import type { HandlerFile } from "./HandlerFile.js";
import { bashPromptContributor } from "./tools/bashPrompt.js";

/**
 * Per-run context handed to every container-side prompt contributor.
 *
 * Deliberately minimal — it carries only what a contributor needs to
 * decide whether and what to contribute, and specifically the two bits
 * the host can't supply to its own `EventContextProvider`s: the
 * resolved active tool set (tool filtering happens in the container) and
 * the `privileged` flag. Add fields here only when a contributor
 * genuinely needs them; do not widen this to the full `AgentRunRow`.
 */
export interface PromptContributorContext {
    /** The resolved handler file driving this agentrun. */
    readonly handler: HandlerFile;
    /** The event topic this agentrun is processing (e.g. `chat:telegram`). */
    readonly topic: string;
    /** Ids of the tools the agent may call for this run (post-filter). */
    readonly toolNames: readonly string[];
    /** Whether the run descends from a trusted user-input source. */
    readonly privileged: boolean;
}

/**
 * A container-side contributor of dynamic-context-block text. Returns
 * the section text (already including its own `## Heading`), or `null`
 * to contribute nothing for this run.
 *
 * Synchronous: contributors read only the passed context plus container
 * env, never I/O. If a future contributor needs async work, widen this
 * to `string | null | Promise<string | null>` and `await` it in
 * {@link import("./PromptBuilder.js").buildRuntimeContextBlock}.
 */
export type PromptContributor = (ctx: PromptContributorContext) => string | null;

/**
 * The ordered list of built-in container prompt contributors. Their
 * (non-empty) sections land in the per-run dynamic context block after
 * the `# Runtime` section and before any host-plugin event-context
 * sections. Order within this list is the rendered order.
 *
 * This is an explicit static registry (mirroring `CONTAINER_TOOL_GROUPS`)
 * rather than import-side-effect registration, so the full set of
 * contributors is visible in one place.
 */
export const CONTAINER_PROMPT_CONTRIBUTORS: readonly PromptContributor[] = [bashPromptContributor];
