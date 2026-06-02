/**
 * Estimate the number of tokens a string occupies in a model's context
 * window. Used to bound tool-result offloading (see {@link import("./ToolRunner.js")})
 * and active context-window management in the container's agent loop.
 *
 * The current heuristic is a coarse `~4 characters per token` — fast,
 * dependency-free, and good enough for the budgeting decisions it backs
 * (offload-or-not, drop-or-not). It deliberately over- nor under-counts
 * by much for typical English/JSON payloads. A real tokenizer
 * (e.g. tiktoken) can be slotted in here later without touching callers.
 *
 * @param text The string to estimate.
 * @returns The estimated token count (always a non-negative integer;
 *   `0` for the empty string).
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}
