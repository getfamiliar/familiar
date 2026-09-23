import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InvoiceRef } from "../api/OwnershipClient.js";
import { renderAmount } from "./Invoices.js";

function invoice(over: Partial<InvoiceRef>): InvoiceRef {
    return {
        kind: "supercharging",
        id: "c1",
        fileName: "x.pdf",
        issuedAt: "2026-08-14T09:12:00.000Z",
        location: null,
        amount: null,
        ...over,
    };
}

describe("renderAmount", () => {
    it("shows a supercharger total as-is", () => {
        assert.equal(renderAmount(invoice({ amount: "13.34 EUR" })), "13.34 EUR");
    });

    it("tells the agent to read the PDF for a connectivity invoice", () => {
        // Tesla's subscription endpoint returns date, id and filename —
        // no amount anywhere. A blank cell would read as "this one was
        // free", which is the wrong conclusion to hand a bookkeeper.
        const text = renderAmount(invoice({ kind: "connectivity" }));
        assert.match(text, /read the PDF/i);
        assert.notEqual(text, "—");
    });

    it("keeps a plain dash for a supercharger row with no fees", () => {
        // Distinct from the connectivity case: here the API genuinely
        // reported nothing to charge, so there is nothing to go read.
        assert.equal(renderAmount(invoice({ kind: "supercharging" })), "—");
    });
});
