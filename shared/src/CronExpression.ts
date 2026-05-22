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
 * The verbatim string is first run through {@link normalizeFriendly}
 * to insert an implicit "at" between a day token (`every day`, `every
 * monday`, `every weekday`, …) and a leading time digit. Without that
 * rewrite, friendly-node-cron either returns null for inputs like
 * `every day 4:00am` *or* — worse — silently mis-parses `every monday
 * 4:00am` to midnight (`0 0 0 * * 1`) because it accepts the day token
 * but doesn't see the hour. Idempotent: applying the rewrite to an
 * already-well-formed expression is a no-op.
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
    const normalized = normalizeFriendly(verbatim);
    try {
        const out = (friendly as unknown as (s: string) => string | null)(normalized);
        return typeof out === "string" && out.length > 0 ? out : null;
    } catch {
        return null;
    }
}

/**
 * Insert a missing `at` between a day token and a leading digit so
 * friendly-node-cron sees a shape it understands.
 *
 * The rewrite triggers on:
 *
 * - `everyday <digit>` → `everyday at <digit>`
 * - `every <word> <digit>` → `every <word> at <digit>` (catches
 *   `every day 4:00am`, `every monday 4:00am`, `every weekday 4:00am`,
 *   `every weekend 4:00am`, etc.)
 *
 * `every 5 minutes` and `every 2 hours` are unaffected because the
 * token after `every` consumes the digit so the trailing `\d` check
 * doesn't match.
 *
 * Exported for unit tests; not in the public index.
 */
export function normalizeFriendly(input: string): string {
    return input.replace(/^(\s*(?:everyday|every\s+\w+))\s+(\d)/i, "$1 at $2");
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
