import { Cron } from "croner";
import friendly from "friendly-node-cron";

/**
 * Result of {@link parseCron} when the input was accepted by either
 * the friendly-node-cron grammar or by Croner directly.
 */
export interface ParsedCron {
    /** Verbatim string from the handler's frontmatter. */
    readonly verbatim: string;
    /** Cron expression Croner runs (friendly output, or the verbatim). */
    readonly expression: string;
    /** Which path accepted the input. */
    readonly source: "friendly" | "raw";
}

/**
 * Parse a cron expression. friendly-node-cron is tried first because
 * its grammar (`every monday at 8 am`) is a strict superset of cron in
 * the directions we care about: it never silently mis-parses a cron
 * expression. When friendly returns `null` (no human-pattern match) we
 * validate the verbatim against Croner.
 *
 * Lives in `shared/` so both the host's `CronjobScheduler` (handler-
 * frontmatter cron) and plugin pollers (e.g. ms365's calendar refresh
 * cron) reach the same parsing contract.
 *
 * @returns `null` when neither path produces a runnable schedule.
 */
export function parseCron(verbatim: string): ParsedCron | null {
    const friendlyResult = tryFriendly(verbatim);
    if (friendlyResult !== null) {
        if (isValidExpression(friendlyResult)) {
            return { verbatim, expression: friendlyResult, source: "friendly" };
        }
    }
    if (isValidExpression(verbatim)) {
        return { verbatim, expression: verbatim, source: "raw" };
    }
    return null;
}

function tryFriendly(verbatim: string): string | null {
    try {
        const out = (friendly as unknown as (s: string) => string | null)(verbatim);
        return typeof out === "string" && out.length > 0 ? out : null;
    } catch {
        return null;
    }
}

/** True iff Croner can construct a (paused) schedule from `expression`. */
function isValidExpression(expression: string): boolean {
    try {
        const job = new Cron(expression, { paused: true }, () => {});
        job.stop();
        return true;
    } catch {
        return false;
    }
}
