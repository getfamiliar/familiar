import type { AgentRunBus, AgentRunRow } from "@getfamiliar/shared";

/**
 * Walk the `parent_agentrun_id` chain upward from `startParentId`, root-first.
 *
 * The cron scheduler (and any future host-side event source) emits root agentruns
 * with `parentAgentrunId = null`; both `queue_handler` (fire-and-forget) and
 * `call_handler` (suspending) link children to their spawning agentrun via this
 * column. Walking the chain therefore yields every prior agentrun that contributed
 * to the current invocation — the surrounding "workflow" tree from the current
 * leaf's perspective.
 *
 * Bounded by `maxDepth` (default 5) as defence in depth against unbounded walks
 * if subagent fan-out grows deep.
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
