import { DateTime } from "luxon";

/**
 * Reformat a UTC ISO-8601 string as a wall-clock-with-offset string in
 * `zone`. Used by every agent-facing surface that reads stored UTC
 * timestamps — calendar events, scheduled handlers, etc. — so the
 * agent always operates in `core.timezone`.
 *
 * Conversion failures (malformed UTC string, unknown zone) fall back
 * to the input string unchanged so a single bad row never crashes an
 * entire read/emit path. Handlers see the raw UTC and can flag the row.
 *
 * @param utcIso - UTC ISO-8601 timestamp (e.g. `2026-05-21T13:00:00Z`).
 * @param zone   - IANA zone name (e.g. `Europe/Berlin`, `UTC`).
 * @returns Wall-clock ISO with offset in `zone` (e.g. `2026-05-21T15:00:00+02:00`).
 */
export function renderInZone(utcIso: string, zone: string): string {
    const dt = DateTime.fromISO(utcIso, { zone: "utc" });
    if (!dt.isValid) {
        return utcIso;
    }
    const local = dt.setZone(zone);
    if (!local.isValid) {
        return utcIso;
    }
    return local.toISO({ suppressMilliseconds: true }) ?? utcIso;
}

/**
 * Result of parsing an agent-supplied wall-clock ISO string. The
 * caller cares about both the canonical UTC ISO (for DB storage) and
 * the original input (for echo-back in tool responses). On failure
 * `error` carries a one-line message.
 */
export type ParseInZoneResult =
    | { readonly ok: true; readonly utcIso: string }
    | { readonly ok: false; readonly error: string };

/**
 * Parse an agent-supplied date string and return the matching UTC ISO.
 *
 * Naive ISO strings (no offset, e.g. `2026-05-22T13:55:00`) are
 * interpreted as wall-clock time in `zone`. Strings with an explicit
 * offset (`2026-05-22T13:55:00+02:00`, `…Z`) are honored verbatim and
 * `zone` is ignored — luxon detects the offset and uses it. The result
 * is always converted to UTC for storage.
 *
 * @param input - Agent-supplied date string.
 * @param zone  - IANA zone name to apply to naive inputs.
 */
export function parseInZone(input: string, zone: string): ParseInZoneResult {
    if (typeof input !== "string" || input.trim().length === 0) {
        return { ok: false, error: "date string is empty" };
    }
    // `setZone: false` keeps an explicit offset from the input (when
    // present) instead of overriding with `zone`; naive inputs fall
    // back to interpreting the wall-clock as `zone` local.
    const parsed = DateTime.fromISO(input, { zone, setZone: false });
    if (!parsed.isValid) {
        return {
            ok: false,
            error: `invalid ISO-8601 date "${input}": ${parsed.invalidExplanation ?? parsed.invalidReason ?? "unknown reason"}`,
        };
    }
    const utc = parsed.toUTC().toISO({ suppressMilliseconds: true });
    if (utc === null) {
        return { ok: false, error: `could not normalize "${input}" to UTC` };
    }
    return { ok: true, utcIso: utc };
}

/**
 * Resolve the [start, endExclusive) UTC bounds of a calendar day in
 * `zone`. The input is a date-only string (`YYYY-MM-DD`); the result
 * gives the matching half-open UTC interval suitable for range
 * queries on UTC-stored timestamps.
 *
 * @param day  - Date-only string `YYYY-MM-DD` interpreted in `zone`.
 * @param zone - IANA zone the day boundaries are measured in.
 */
export function dayBoundsInZone(
    day: string,
    zone: string,
):
    | { readonly ok: true; readonly fromUtc: string; readonly toUtc: string }
    | {
          readonly ok: false;
          readonly error: string;
      } {
    const start = DateTime.fromISO(day, { zone });
    if (!start.isValid) {
        return {
            ok: false,
            error: `invalid day "${day}": ${start.invalidExplanation ?? start.invalidReason ?? "unknown reason"}`,
        };
    }
    const dayStart = start.startOf("day");
    const dayEnd = dayStart.plus({ days: 1 });
    const fromUtc = dayStart.toUTC().toISO({ suppressMilliseconds: true });
    const toUtc = dayEnd.toUTC().toISO({ suppressMilliseconds: true });
    if (fromUtc === null || toUtc === null) {
        return { ok: false, error: `could not normalize day "${day}" to UTC bounds` };
    }
    return { ok: true, fromUtc, toUtc };
}
