import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TeslaConfig } from "../Config.js";
import { OwnershipClient } from "./OwnershipClient.js";

const CONFIG: TeslaConfig = {
    wakeTimeoutSeconds: 30,
    deviceCountry: "DE",
    deviceLanguage: "de",
    locale: "de_DE",
    teslaAppUserAgent: "TeslaApp/4.28.3-2167",
    userAgent: "Tesla/1195 CFNetwork/1388 Darwin/22.0.0",
};

/**
 * Replace the global `fetch` with one that answers every request from
 * `bodies`, keyed by a substring of the URL, and records the URLs and
 * headers it saw. Returns a restore closure the test must call.
 */
function stubFetch(bodies: Record<string, unknown>): {
    restore: () => void;
    calls: { url: string; headers: Record<string, string> }[];
} {
    const original = globalThis.fetch;
    const calls: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({
            url,
            headers: (init?.headers ?? {}) as Record<string, string>,
        });
        const key = Object.keys(bodies).find((k) => url.includes(k));
        if (key === undefined) {
            return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify(bodies[key]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof globalThis.fetch;
    return {
        restore: () => {
            globalThis.fetch = original;
        },
        calls,
    };
}

describe("OwnershipClient.listChargingInvoices", () => {
    it("normalises camelCase sessions and totals their fees", async () => {
        const { restore, calls } = stubFetch({
            "/charging/history": {
                data: [
                    {
                        chargeStartDateTime: "2026-08-14T09:12:00Z",
                        siteLocationName: "Kassel-Lohfelden",
                        fees: [
                            { currencyCode: "EUR", totalDue: 12.3 },
                            { currencyCode: "EUR", totalDue: 1.04 },
                        ],
                        invoices: [{ fileName: "inv-1.pdf", contentId: "c1" }],
                    },
                ],
            },
        });
        try {
            const client = new OwnershipClient(async () => "tok", CONFIG);
            const invoices = await client.listChargingInvoices("VIN1");
            assert.equal(invoices.length, 1);
            assert.deepEqual(invoices[0], {
                kind: "supercharging",
                id: "c1",
                fileName: "inv-1.pdf",
                issuedAt: "2026-08-14T09:12:00.000Z",
                location: "Kassel-Lohfelden",
                amount: "13.34 EUR",
            });
            // The full history only comes back with this operation name.
            assert.match(calls[0].url, /operationName=getChargingHistoryV2/);
            assert.match(calls[0].url, /httpLocale=de_DE/);
            assert.equal(calls[0].headers["x-tesla-user-agent"], CONFIG.teslaAppUserAgent);
        } finally {
            restore();
        }
    });

    it("skips free sessions, which carry no invoice", async () => {
        const { restore } = stubFetch({
            "/charging/history": {
                data: [
                    { chargeStartDateTime: "2026-08-14T09:12:00Z", invoices: null },
                    { chargeStartDateTime: "2026-08-15T09:12:00Z", invoices: [] },
                ],
            },
        });
        try {
            const client = new OwnershipClient(async () => "tok", CONFIG);
            assert.deepEqual(await client.listChargingInvoices("VIN1"), []);
        } finally {
            restore();
        }
    });

    it("falls back to unlatchDateTime when the session has no start time", async () => {
        const { restore } = stubFetch({
            "/charging/history": {
                data: [
                    {
                        unlatchDateTime: "2026-08-14T10:00:00Z",
                        invoices: [{ contentId: "c2" }],
                    },
                ],
            },
        });
        try {
            const client = new OwnershipClient(async () => "tok", CONFIG);
            const invoices = await client.listChargingInvoices("VIN1");
            assert.equal(invoices[0].issuedAt, "2026-08-14T10:00:00.000Z");
            // No fileName in the payload — fall back to the content id.
            assert.equal(invoices[0].fileName, "c2.pdf");
            assert.equal(invoices[0].amount, null);
        } finally {
            restore();
        }
    });
});

describe("OwnershipClient.listConnectivityInvoices", () => {
    it("normalises the PascalCase subscription payload", async () => {
        const { restore, calls } = stubFetch({
            "/subscriptions/invoices": {
                data: [
                    {
                        InvoiceDate: "2026-08-01T00:00:00Z",
                        InvoiceId: "9f3c",
                        InvoiceFileName: "premium-connectivity.pdf",
                    },
                ],
            },
        });
        try {
            const client = new OwnershipClient(async () => "tok", CONFIG);
            const invoices = await client.listConnectivityInvoices("VIN1");
            assert.deepEqual(invoices[0], {
                kind: "connectivity",
                id: "9f3c",
                fileName: "premium-connectivity.pdf",
                issuedAt: "2026-08-01T00:00:00.000Z",
                location: null,
                amount: null,
            });
            // The product code is mandatory on this endpoint.
            assert.match(calls[0].url, /optionCode=%24CPF1/);
        } finally {
            restore();
        }
    });
});

describe("OwnershipClient.downloadInvoice", () => {
    it("uses the documents path for connectivity and the charging path otherwise", async () => {
        const { restore, calls } = stubFetch({ "/mobile-app/": {} });
        try {
            const client = new OwnershipClient(async () => "tok", CONFIG);
            const base = {
                fileName: "x.pdf",
                issuedAt: "2026-08-01T00:00:00.000Z",
                location: null,
                amount: null,
            };
            await client.downloadInvoice({ ...base, kind: "supercharging", id: "c1" }, "VIN1");
            await client.downloadInvoice({ ...base, kind: "connectivity", id: "9f3c" }, "VIN1");
            assert.match(calls[0].url, /\/mobile-app\/charging\/invoice\/c1\?/);
            assert.match(calls[1].url, /\/mobile-app\/documents\/invoices\/9f3c\?/);
        } finally {
            restore();
        }
    });
});
