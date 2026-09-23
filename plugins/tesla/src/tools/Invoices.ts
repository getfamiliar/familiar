import { randomBytes } from "node:crypto";
import {
    escapeTableCell,
    markdownTable,
    type PluginTool,
    renderInZone,
    runTextTool,
    ToolError,
} from "@getfamiliar/shared";
import type { InvoiceKind, InvoiceRef } from "../api/OwnershipClient.js";
import type { TeslaSession } from "../auth/ActiveSession.js";
import { readTimezone } from "../Config.js";
import { type InvoicePeriod, isWithinPeriod, resolvePeriod } from "./InvoicePeriod.js";
import { describeVehicle, requireSession, resolveVehicle } from "./ResolveVehicle.js";

/**
 * Stand-in for the amount of a subscription invoice, which Tesla's API
 * does not expose at all. Phrased as an instruction because it lands
 * in the agent's result table, where a blank or a dash would read as
 * "this invoice was free".
 */
const AMOUNT_ONLY_IN_PDF = "read the PDF at filepath — not in the API";

/** Args accepted by `tesla_invoices`. */
export interface InvoicesArgs {
    readonly from_day?: string;
    readonly to_day?: string;
    readonly kind?: InvoiceKind;
}

/**
 * Build `tesla_invoices` — download the accounting documents for a
 * period into the event's scratch directory.
 *
 * Two unrelated billing sources are merged: Supercharger session
 * invoices (one per paid charge) and Premium Connectivity subscription
 * invoices (one per billing period). Each PDF is staged as its own
 * file under `/scratch/<event-id>/` and the result is a table with one
 * row per document, so the agent can attach or file them by path
 * without ever holding the bytes.
 *
 * @returns The tool definition.
 */
export function buildInvoicesTool(): PluginTool<InvoicesArgs, string> {
    return {
        name: "invoices",
        description:
            "Download Tesla billing documents as PDFs for a period and stage them in the " +
            "scratch directory. Covers Supercharger session invoices and Premium " +
            "Connectivity subscription invoices. `from_day` / `to_day` are inclusive " +
            "`YYYY-MM-DD` local days; omit both to get the **last full month**, which is the " +
            "usual monthly-bookkeeping request. Set `kind` to fetch only one of the two " +
            "sources. Returns a markdown table with one row per document: `filepath | kind | " +
            "date | location | amount`. The files live under `/scratch/<event-id>/` and are " +
            "swept after 24 hours, so attach or file them in the same run. Supercharger " +
            "rows carry their total in `amount`; connectivity rows cannot — Tesla does not " +
            "return it — so their `amount` cell tells you to read the figure out of the PDF.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                from_day: {
                    type: "string",
                    description: "Inclusive lower-bound local day (YYYY-MM-DD).",
                },
                to_day: {
                    type: "string",
                    description: "Inclusive upper-bound local day (YYYY-MM-DD).",
                },
                kind: {
                    type: "string",
                    enum: ["supercharging", "connectivity"],
                    description:
                        "Restrict to one billing source. Omit for both. " +
                        "`supercharging` = per-charge invoices, `connectivity` = the " +
                        "Premium Connectivity subscription.",
                },
            },
        },
        execute: (args, callCtx) =>
            runTextTool(async () => {
                const session = requireSession();
                const resolution = await resolveVehicle(session);
                if (resolution.kind === "needs-choice") {
                    return resolution.message;
                }
                const zone = readTimezone(callCtx.host);
                const period = resolvePeriod(args, new Date(), zone);
                const vin = resolution.vehicle.vin;
                if (vin.length === 0) {
                    // Both billing endpoints reject a request without a
                    // VIN; fail with the reason rather than a raw 400.
                    throw new ToolError(
                        "NO_VIN",
                        `${describeVehicle(resolution.vehicle)} reports no VIN, which the ` +
                            "Tesla billing endpoints require",
                    );
                }

                const wanted = await collectInvoices(session, vin, args.kind, period, zone);
                if (wanted.length === 0) {
                    return renderEmpty(period, args.kind);
                }

                const suffix = randomBytes(3).toString("hex");
                const files: { name: string; contents: Buffer }[] = [];
                for (const [index, invoice] of wanted.entries()) {
                    const contents = await session.ownership.downloadInvoice(invoice, vin);
                    files.push({ name: scratchName(invoice, index, suffix), contents });
                }
                const paths = await callCtx.host.scratch.addFiles(callCtx.event.id, files);

                return renderResult(period, wanted, paths, zone);
            }, callCtx.toolRunContext),
    };
}

/**
 * Fetch both billing sources (or just the requested one) and keep the
 * invoices that fall inside the period, newest first.
 *
 * @param session The active session.
 * @param vin The vehicle's VIN; required by both endpoints.
 * @param kind Restrict to one source, or `undefined` for both.
 * @param period The resolved day range.
 * @param zone IANA zone the days are interpreted in.
 * @returns The matching invoices, most recent first.
 */
async function collectInvoices(
    session: TeslaSession,
    vin: string,
    kind: InvoiceKind | undefined,
    period: InvoicePeriod,
    zone: string,
): Promise<readonly InvoiceRef[]> {
    const lists: readonly InvoiceRef[][] = await Promise.all([
        kind === "connectivity"
            ? Promise.resolve([])
            : session.ownership.listChargingInvoices(vin).then((r) => [...r]),
        kind === "supercharging"
            ? Promise.resolve([])
            : session.ownership.listConnectivityInvoices(vin).then((r) => [...r]),
    ]);
    return lists
        .flat()
        .filter((invoice) => isWithinPeriod(invoice.issuedAt, period, zone))
        .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}

/**
 * Scratch filename for one invoice. The kind and a per-call random
 * suffix keep concurrent calls and same-day invoices from clobbering
 * each other, since `scratch.addFiles` overwrites on name collision.
 *
 * @param invoice The invoice being staged.
 * @param index Position within this call, for stable ordering.
 * @param suffix Per-call random suffix.
 * @returns A safe basename ending in `.pdf`.
 */
function scratchName(invoice: InvoiceRef, index: number, suffix: string): string {
    const day = invoice.issuedAt.slice(0, 10);
    return `tesla.${invoice.kind}.${day}.${index + 1}.${suffix}.pdf`;
}

/**
 * What the amount column says.
 *
 * Supercharger sessions carry their fees in the API, so those render as
 * a total. Subscription invoices do **not** — Tesla's subscription
 * endpoint returns only a date, an id and a filename, and the amount
 * exists nowhere but inside the PDF. Leaving that cell blank invites
 * the agent to report the invoice as having no cost, so the cell
 * carries the instruction instead: the value is obtainable, just not
 * from here.
 *
 * @param invoice The invoice being rendered.
 * @returns The amount, or the instruction that replaces it.
 */
export function renderAmount(invoice: InvoiceRef): string {
    if (invoice.amount !== null) {
        return invoice.amount;
    }
    if (invoice.kind === "connectivity") {
        return AMOUNT_ONLY_IN_PDF;
    }
    return "—";
}

/**
 * Render the "nothing matched" answer, naming the period so the agent
 * can tell the user what was actually searched.
 *
 * @param period The resolved range.
 * @param kind The requested source, if narrowed.
 * @returns A one-line markdown answer.
 */
function renderEmpty(period: InvoicePeriod, kind: InvoiceKind | undefined): string {
    const what = kind === undefined ? "invoices" : `${kind} invoices`;
    return `No ${what} between ${period.fromDay} and ${period.toDay} (inclusive).\n`;
}

/**
 * Render the result table: a summary line plus one row per staged PDF.
 *
 * @param period The resolved range.
 * @param invoices The matching invoices, in the order they were staged.
 * @param paths The scratch paths `addFiles` returned, in the same order.
 * @param zone IANA zone for rendering the dates.
 * @returns Markdown text for the agent.
 */
function renderResult(
    period: InvoicePeriod,
    invoices: readonly InvoiceRef[],
    paths: readonly string[],
    zone: string,
): string {
    const table = markdownTable(
        ["filepath", "kind", "date", "location", "amount"],
        invoices.map((invoice, i) => [
            paths[i] ?? "",
            invoice.kind,
            renderInZone(invoice.issuedAt, zone).slice(0, 10),
            escapeTableCell(invoice.location ?? "—"),
            renderAmount(invoice),
        ]),
    );
    return (
        `${invoices.length} invoice(s) between ${period.fromDay} and ${period.toDay} ` +
        `(inclusive), staged as PDFs.\n\n${table}`
    );
}
