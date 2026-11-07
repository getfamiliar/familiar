/**
 * Format a `Date` for the runtime facts:
 * `Friday, 2026-05-19T18:43:12 in timezone Europe/Berlin`.
 *
 * Weekday name + ISO-like local time + the IANA tz label, all relative
 * to `timezone`. Built from `Intl.DateTimeFormat.formatToParts` so we
 * control the separators directly — the locale-default formatter
 * inserts AM/PM and locale punctuation we don't want.
 *
 * @param date The instant to format.
 * @param timezone IANA timezone.
 * @returns The formatted string.
 */
export function formatRuntimeTime(date: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "long",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(date);
    const lookup = new Map(parts.map((p) => [p.type, p.value]));
    const weekday = lookup.get("weekday") ?? "";
    const year = lookup.get("year") ?? "";
    const month = lookup.get("month") ?? "";
    const day = lookup.get("day") ?? "";
    // `hour: '2-digit'` with `hour12: false` can yield "24" at midnight
    // on some implementations; normalise to "00".
    const rawHour = lookup.get("hour") ?? "";
    const hour = rawHour === "24" ? "00" : rawHour;
    const minute = lookup.get("minute") ?? "";
    const second = lookup.get("second") ?? "";
    return `${weekday}, ${year}-${month}-${day}T${hour}:${minute}:${second} in timezone ${timezone}`;
}
