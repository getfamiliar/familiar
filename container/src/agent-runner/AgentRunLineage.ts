import type { AgentRunBus, AgentRunRow } from "effective-assistant-shared";

/**
 * Walk the `parent_agentrun_id` chain upward from `startParentId`, root-first.
 *
 * The cron scheduler (and any future host-side event source) emits root agentruns
 * with `parentAgentrunId = null`; `queue_run` from inside a handler links children
 * to their spawning agentrun via this column. Walking the chain therefore yields
 * every prior agentrun that contributed to the current invocation — the surrounding
 * "workflow" tree from the current leaf's perspective.
 *
 * Bounded by `maxDepth` (default 5) as defence in depth: the queue_run tool already
 * enforces a tree-depth cap of 3, so 5 leaves head-room without inviting accidental
 * unbounded walks if the cap ever changes upstream.
 *
 * If a recorded parent id points to a row that no longer exists (cascade delete
 * or test fixture quirk) the walk stops at the broken link rather than throwing —
 * we'd rather show the partial chain than fail the whole agentrun on a missing
 * ancestor.
 *
 * @returns ancestors in root-first order (oldest first). Empty when `startParentId`
 *   is `null` or the immediate parent fetch returns no row.
 */
export async function fetchAncestorChain(
    bus: Pick<AgentRunBus, "getById">,
    startParentId: string | null,
    maxDepth = 5,
): Promise<readonly AgentRunRow[]> {
    const out: AgentRunRow[] = [];
    let cursor = startParentId;
    while (cursor !== null && out.length < maxDepth) {
        const row = await bus.getById(cursor);
        if (!row) {
            break;
        }
        out.push(row);
        cursor = row.parentAgentrunId;
    }
    return out.reverse();
}
