import { Buffer } from "node:buffer";
import type { TeslaConfig } from "../Config.js";
import { fetchWithRetry } from "../HttpRetry.js";
import type { TokenProvider } from "./OwnerApiClient.js";
import { TeslaApiError } from "./TeslaApiError.js";

/**
 * Billing host. Distinct from `owner-api.teslamotors.com` — invoices
 * live behind the mobile app's backend-for-frontend, not the vehicle
 * API. The paths below are the `bff/v2/mobile-app/...` entries from the
 * app's endpoint table **with the `bff/v2` prefix dropped**; keeping
 * the prefix is the single most common mistake when reproducing these
 * calls and yields a "param is missing" error.
 */
const OWNERSHIP_BASE = "https://ownership.tesla.com";

/** Product code identifying the Premium Connectivity subscription. Required. */
const PREMIUM_CONNECTIVITY_OPTION_CODE = "$CPF1";

/** Which of the two billing sources an invoice came from. */
export type InvoiceKind = "supercharging" | "connectivity";

/** One downloadable invoice, normalised across the two sources. */
export interface InvoiceRef {
    readonly kind: InvoiceKind;
    /** `contentId` for charging, `InvoiceId` for connectivity. */
    readonly id: string;
    /** Tesla's own filename for the PDF. */
    readonly fileName: string;
    /** ISO-8601 instant the invoice is dated. */
    readonly issuedAt: string;
    /** Supercharger site name; `null` for connectivity invoices. */
    readonly location: string | null;
    /** Rendered total (e.g. `"12.34 EUR"`), or `null` when the source carries no fees. */
    readonly amount: string | null;
}

/**
 * Client for Tesla's billing endpoints: Supercharger session invoices
 * and Premium Connectivity subscription invoices.
 *
 * These endpoints only answer requests that look like the Tesla mobile
 * app, so every call carries `x-tesla-user-agent` alongside a
 * CFNetwork-style `User-Agent`. Both strings are pinned to app
 * releases and rot; they come from config
 * ({@link TeslaConfig.teslaAppUserAgent}) rather than being constants
 * here, because a sudden 403 from this host is almost always a stale
 * app version rather than a broken token.
 *
 * Neither endpoint filters by date server-side — both return the
 * account's full history and the caller narrows it.
 */
export class OwnershipClient {
    private readonly tokenProvider: TokenProvider;
    private readonly config: TeslaConfig;

    constructor(tokenProvider: TokenProvider, config: TeslaConfig) {
        this.tokenProvider = tokenProvider;
        this.config = config;
    }

    /**
     * List every Supercharger session that produced an invoice.
     * Sessions on free supercharging carry `invoices: null` and are
     * skipped.
     *
     * @param vin Vehicle VIN. Required by the endpoint even though it
     *   no longer filters by it.
     * @returns The invoices, unfiltered by date.
     * @throws {TeslaApiError} On any non-2xx answer.
     */
    async listChargingInvoices(vin: string): Promise<readonly InvoiceRef[]> {
        const url = this.buildUrl("/mobile-app/charging/history", vin, {
            // The endpoint answers with the account's full session list
            // only when this is present; without it it degrades to the
            // few most recent sessions.
            operationName: "getChargingHistoryV2",
        });
        const body = await this.getJson<{ data?: readonly RawChargingSession[] }>(url);
        const out: InvoiceRef[] = [];
        for (const session of body.data ?? []) {
            const issuedAt = normalizeDate(session.chargeStartDateTime ?? session.unlatchDateTime);
            if (issuedAt === null) {
                continue;
            }
            for (const invoice of session.invoices ?? []) {
                if (typeof invoice?.contentId !== "string" || invoice.contentId.length === 0) {
                    continue;
                }
                out.push({
                    kind: "supercharging",
                    id: invoice.contentId,
                    fileName:
                        typeof invoice.fileName === "string" && invoice.fileName.length > 0
                            ? invoice.fileName
                            : `${invoice.contentId}.pdf`,
                    issuedAt,
                    location:
                        typeof session.siteLocationName === "string"
                            ? session.siteLocationName
                            : null,
                    amount: renderFees(session.fees),
                });
            }
        }
        return out;
    }

    /**
     * List the Premium Connectivity subscription invoices.
     *
     * @param vin Vehicle VIN.
     * @returns The invoices, unfiltered by date.
     * @throws {TeslaApiError} On any non-2xx answer.
     */
    async listConnectivityInvoices(vin: string): Promise<readonly InvoiceRef[]> {
        const url = this.buildUrl("/mobile-app/subscriptions/invoices", vin, {
            optionCode: PREMIUM_CONNECTIVITY_OPTION_CODE,
        });
        const body = await this.getJson<{ data?: readonly RawSubscriptionInvoice[] }>(url);
        const out: InvoiceRef[] = [];
        // Note the casing: this endpoint answers in PascalCase while
        // the charging one answers in camelCase. Same vendor, same
        // host, different teams.
        for (const invoice of body.data ?? []) {
            if (typeof invoice?.InvoiceId !== "string" || invoice.InvoiceId.length === 0) {
                continue;
            }
            const issuedAt = normalizeDate(invoice.InvoiceDate);
            if (issuedAt === null) {
                continue;
            }
            out.push({
                kind: "connectivity",
                id: invoice.InvoiceId,
                fileName:
                    typeof invoice.InvoiceFileName === "string" &&
                    invoice.InvoiceFileName.length > 0
                        ? invoice.InvoiceFileName
                        : `${invoice.InvoiceId}.pdf`,
                issuedAt,
                location: null,
                amount: null,
            });
        }
        return out;
    }

    /**
     * Download one invoice's PDF. The two kinds live behind different
     * paths; the {@link InvoiceRef.kind} picks which.
     *
     * @param invoice The invoice to fetch.
     * @param vin Vehicle VIN, required on both paths.
     * @returns The raw PDF bytes (the endpoints return binary, not base64).
     * @throws {TeslaApiError} On any non-2xx answer.
     */
    async downloadInvoice(invoice: InvoiceRef, vin: string): Promise<Buffer> {
        const path =
            invoice.kind === "supercharging"
                ? `/mobile-app/charging/invoice/${encodeURIComponent(invoice.id)}`
                : `/mobile-app/documents/invoices/${encodeURIComponent(invoice.id)}`;
        const url = this.buildUrl(path, vin);
        const response = await fetchWithRetry(url, { headers: await this.headers() });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new TeslaApiError(response.status, url, text);
        }
        return Buffer.from(await response.arrayBuffer());
    }

    /**
     * Build a billing URL with the locale/device parameters every one
     * of these endpoints expects.
     *
     * @param path Path below {@link OWNERSHIP_BASE}.
     * @param vin Vehicle VIN.
     * @param extra Additional query parameters for this specific call.
     * @returns The absolute URL.
     */
    private buildUrl(path: string, vin: string, extra?: Record<string, string>): string {
        const url = new URL(path, OWNERSHIP_BASE);
        url.searchParams.set("deviceLanguage", this.config.deviceLanguage);
        url.searchParams.set("deviceCountry", this.config.deviceCountry);
        // `httpLocale` here — the charging GraphQL surface spells the
        // same concept `ttpLocale`, which is a different endpoint and
        // not the one this client talks to.
        url.searchParams.set("httpLocale", this.config.locale);
        url.searchParams.set("vin", vin);
        for (const [key, value] of Object.entries(extra ?? {})) {
            url.searchParams.set(key, value);
        }
        return url.toString();
    }

    /**
     * Assemble the request headers, refreshing the bearer token if the
     * auth layer says it is due.
     *
     * @returns The headers for a billing request.
     */
    private async headers(): Promise<Record<string, string>> {
        return {
            Authorization: `Bearer ${await this.tokenProvider()}`,
            "x-tesla-user-agent": this.config.teslaAppUserAgent,
            "User-Agent": this.config.userAgent,
        };
    }

    /**
     * Issue a GET and parse the JSON envelope.
     *
     * @param url Absolute URL.
     * @returns The parsed body.
     * @throws {TeslaApiError} On any non-2xx answer.
     */
    private async getJson<T>(url: string): Promise<T> {
        const response = await fetchWithRetry(url, {
            headers: { ...(await this.headers()), Accept: "application/json" },
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new TeslaApiError(response.status, url, text);
        }
        return (await response.json()) as T;
    }
}

/** One charging session as the history endpoint reports it (camelCase). */
interface RawChargingSession {
    readonly chargeStartDateTime?: unknown;
    readonly unlatchDateTime?: unknown;
    readonly siteLocationName?: unknown;
    readonly fees?: readonly RawFee[] | null;
    readonly invoices?: readonly { fileName?: unknown; contentId?: unknown }[] | null;
}

/** One fee line on a charging session. */
interface RawFee {
    readonly currencyCode?: unknown;
    readonly totalDue?: unknown;
}

/** One subscription invoice as its endpoint reports it (PascalCase). */
interface RawSubscriptionInvoice {
    readonly InvoiceDate?: unknown;
    readonly InvoiceId?: unknown;
    readonly InvoiceFileName?: unknown;
}

/**
 * Sum a session's fee lines into a single rendered total.
 *
 * @param fees The session's fee array, possibly absent.
 * @returns e.g. `"12.34 EUR"`, or `null` when there is nothing to total.
 */
function renderFees(fees: readonly RawFee[] | null | undefined): string | null {
    if (fees === null || fees === undefined || fees.length === 0) {
        return null;
    }
    let total = 0;
    let currency: string | null = null;
    for (const fee of fees) {
        if (typeof fee.totalDue === "number") {
            total += fee.totalDue;
        }
        if (currency === null && typeof fee.currencyCode === "string") {
            currency = fee.currencyCode;
        }
    }
    if (currency === null) {
        return null;
    }
    return `${total.toFixed(2)} ${currency}`;
}

/**
 * Normalise a timestamp from either source into an ISO-8601 string.
 *
 * @param value The raw field value.
 * @returns The ISO instant, or `null` when the value is unusable.
 */
function normalizeDate(value: unknown): string | null {
    if (typeof value !== "string" || value.length === 0) {
        return null;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
