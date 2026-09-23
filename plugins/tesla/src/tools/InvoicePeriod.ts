import { renderInZone, ToolError } from "@getfamiliar/shared";

/** An inclusive local-day range, both bounds as `YYYY-MM-DD`. */
export interface InvoicePeriod {
    readonly fromDay: string;
    readonly toDay: string;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve the day range `tesla_invoices` filters on.
 *
 * Neither Tesla billing endpoint filters by date server-side, so the
 * range only ever narrows a list we already hold — which is why it can
 * be plain inclusive local days rather than instants.
 *
 * Omitting both bounds selects the **last full month**, which is the
 * monthly-bookkeeping case: asked in September, it returns August.
 * Supplying only one bound leaves the other open-ended.
 *
 * @param args The caller's `from_day` / `to_day`, either possibly absent.
 * @param now Reference instant used to derive the default month.
 * @param zone IANA zone the days are interpreted in (`core.timezone`).
 * @returns The resolved inclusive range.
 * @throws {ToolError} When a bound is not `YYYY-MM-DD` or the range is inverted.
 */
export function resolvePeriod(
    args: { readonly from_day?: string; readonly to_day?: string },
    now: Date,
    zone: string,
): InvoicePeriod {
    const from = validateDay(args.from_day, "from_day");
    const to = validateDay(args.to_day, "to_day");

    if (from === null && to === null) {
        return lastFullMonth(now, zone);
    }
    const period: InvoicePeriod = {
        fromDay: from ?? "0000-01-01",
        toDay: to ?? "9999-12-31",
    };
    if (period.fromDay > period.toDay) {
        throw new ToolError(
            "INVALID_ARGUMENT",
            `from_day (${period.fromDay}) is after to_day (${period.toDay})`,
        );
    }
    return period;
}

/**
 * Whether an invoice falls inside the range, comparing the local day
 * its timestamp lands on rather than the raw UTC instant — an invoice
 * issued at 00:30 local on the 1st belongs to that month for the user
 * even if it is still the previous day in UTC.
 *
 * @param issuedAtIso The invoice's ISO instant.
 * @param period The resolved range.
 * @param zone IANA zone the days are interpreted in.
 * @returns True when the invoice belongs to the range.
 */
export function isWithinPeriod(issuedAtIso: string, period: InvoicePeriod, zone: string): boolean {
    const localDay = renderInZone(issuedAtIso, zone).slice(0, 10);
    return localDay >= period.fromDay && localDay <= period.toDay;
}

/**
 * The full calendar month before the one `now` falls in, in `zone`.
 *
 * @param now Reference instant.
 * @param zone IANA zone.
 * @returns First and last day of the previous month.
 */
function lastFullMonth(now: Date, zone: string): InvoicePeriod {
    const [yearText, monthText] = renderInZone(now.toISOString(), zone).slice(0, 7).split("-");
    const year = Number.parseInt(yearText, 10);
    const month = Number.parseInt(monthText, 10);
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    // Day 0 of the following month is the last day of `prevMonth`,
    // which handles both month lengths and leap years.
    const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
    const stamp = `${String(prevYear).padStart(4, "0")}-${String(prevMonth).padStart(2, "0")}`;
    return { fromDay: `${stamp}-01`, toDay: `${stamp}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * Validate one optional day bound.
 *
 * @param value The raw argument value.
 * @param field Argument name, used in the error message.
 * @returns The validated day, or `null` when the bound was omitted.
 * @throws {ToolError} When the value is present but not `YYYY-MM-DD`.
 */
function validateDay(value: string | undefined, field: string): string | null {
    if (value === undefined || value === null || value.length === 0) {
        return null;
    }
    if (typeof value !== "string" || !DAY_PATTERN.test(value)) {
        throw new ToolError("INVALID_ARGUMENT", `${field} must be a YYYY-MM-DD date, got ${value}`);
    }
    return value;
}
