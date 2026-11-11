/**
 * Context window (tokens) assumed when the model's metadata is unavailable:
 * for tool-result eviction and for sizing `fs_read` chunks. Conservative on
 * purpose — at worst a large tool result lands in scratch a bit early, or a
 * file is read in a few more chunks.
 */
export const FALLBACK_CONTEXT_LIMIT = 64_000;
