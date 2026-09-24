import { DateTime } from "luxon";

/**
 * Agent-facing local-day inputs. Either `day` alone or `from_day` +
 * `to_day` together (both `YYYY-MM-DD`, interpreted in `core.timezone`).
 */
export interface DayArgs {
    readonly day?: string;
    readonly from_day?: string;
    readonly to_day?: string;
}

/**
 * Translate the agent's day-resolution local-TZ inputs into the UTC
 * half-open `[from, to)` interval. Accepts either `day` alone or
 * `from_day` + `to_day` together; rejects mixed / missing combinations
 * with an agent-readable error.
 *
 * `to_day` is **inclusive** at the user-facing layer (Mon–Wed includes
 * Wed), so the upper bound becomes `to_day + 1` at the start-of-day in
 * `coreTz` before converting to UTC.
 *
 * @param args - The agent's day arguments.
 * @param coreTz - IANA zone the days are interpreted in.
 * @returns UTC ISO bounds `{from, to}` of the half-open interval.
 * @throws Error on mixed, missing, malformed or inverted inputs.
 */
export function resolveDayBounds(args: DayArgs, coreTz: string): { from: string; to: string } {
    const hasDay = isNonEmpty(args.day);
    const hasFromDay = isNonEmpty(args.from_day);
    const hasToDay = isNonEmpty(args.to_day);
    if (hasDay && (hasFromDay || hasToDay)) {
        throw new Error("pass either `day` or `from_day`+`to_day`, not both");
    }
    if (!hasDay && hasFromDay !== hasToDay) {
        throw new Error("`from_day` and `to_day` must be set together");
    }
    if (!hasDay && !hasFromDay) {
        throw new Error("provide `day` (single day) or `from_day`+`to_day` (range)");
    }
    const fromDay = hasDay ? (args.day as string) : (args.from_day as string);
    const toDay = hasDay ? (args.day as string) : (args.to_day as string);
    const bounds = resolveOpenDayBounds({ from_day: fromDay, to_day: toDay }, coreTz);
    if (bounds.from === undefined || bounds.to === undefined) {
        throw new Error("failed to convert day bounds to UTC");
    }
    return { from: bounds.from, to: bounds.to };
}

/**
 * Open-ended variant of {@link resolveDayBounds}: either side may be
 * omitted. `from_day` becomes the start of that local day, `to_day`
 * (inclusive) the start of the following local day, both in UTC.
 *
 * @param args - Optional `from_day` / `to_day` (`YYYY-MM-DD`).
 * @param coreTz - IANA zone the days are interpreted in.
 * @returns UTC ISO bounds; a side is `undefined` when its input was omitted.
 * @throws Error on malformed days or `from_day` after `to_day`.
 */
export function resolveOpenDayBounds(
    args: { readonly from_day?: string; readonly to_day?: string },
    coreTz: string,
): { from?: string; to?: string } {
    const lower = isNonEmpty(args.from_day) ? parseDayStart(args.from_day, coreTz) : undefined;
    const upper = isNonEmpty(args.to_day)
        ? parseDayStart(args.to_day, coreTz).plus({ days: 1 })
        : undefined;
    if (lower !== undefined && upper !== undefined && upper <= lower) {
        throw new Error(`from_day "${args.from_day}" must not be after to_day "${args.to_day}"`);
    }
    return {
        from: lower !== undefined ? toUtcIso(lower) : undefined,
        to: upper !== undefined ? toUtcIso(upper) : undefined,
    };
}

/**
 * Parse `YYYY-MM-DD` as the start of that day in `coreTz`.
 *
 * @throws Error when the day does not parse.
 */
function parseDayStart(day: string, coreTz: string): DateTime {
    const parsed = DateTime.fromISO(day, { zone: coreTz }).startOf("day");
    if (!parsed.isValid) {
        throw new Error(`invalid day "${day}" — expected YYYY-MM-DD`);
    }
    return parsed;
}

/**
 * Render a luxon instant as a UTC ISO string without milliseconds.
 *
 * @throws Error when luxon cannot render it.
 */
function toUtcIso(dt: DateTime): string {
    const iso = dt.toUTC().toISO({ suppressMilliseconds: true });
    if (!iso) {
        throw new Error("failed to convert day bounds to UTC");
    }
    return iso;
}

/** Type guard: a string with at least one character. */
function isNonEmpty(value: string | undefined): value is string {
    return typeof value === "string" && value.length > 0;
}
