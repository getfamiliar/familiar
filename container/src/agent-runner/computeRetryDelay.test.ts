import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { APICallError } from "@ai-sdk/provider";
import { computeRetryDelay } from "./computeRetryDelay.js";

function withHeaders(headers: Record<string, string | undefined>): APICallError {
    return new APICallError({
        message: "boom",
        url: "https://api.example.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 503,
        responseHeaders: headers,
    });
}

describe("computeRetryDelay — exponential fallback", () => {
    it("first attempt waits 2000ms when no headers are present", () => {
        const err = new APICallError({
            message: "boom",
            url: "x",
            requestBodyValues: {},
            statusCode: 503,
        });
        assert.equal(computeRetryDelay(err, 0), 2000);
    });

    it("doubles each attempt up to the 5-minute cap", () => {
        const err = withHeaders({});
        assert.equal(computeRetryDelay(err, 0), 2000);
        assert.equal(computeRetryDelay(err, 1), 4000);
        assert.equal(computeRetryDelay(err, 2), 8000);
        assert.equal(computeRetryDelay(err, 10), 5 * 60 * 1000); // capped
    });

    it("treats negative attempts defensively as 0", () => {
        assert.equal(computeRetryDelay(withHeaders({}), -1), 2000);
    });
});

describe("computeRetryDelay — retry-after-ms header", () => {
    it("parses numeric milliseconds", () => {
        assert.equal(computeRetryDelay(withHeaders({ "retry-after-ms": "1500" }), 0), 1500);
    });

    it("ignores garbage values and falls back to exponential", () => {
        assert.equal(computeRetryDelay(withHeaders({ "retry-after-ms": "soon" }), 0), 2000);
    });

    it("clamps absurdly long header delays at the 5-minute cap", () => {
        // 10 minutes > 60s and > current exponential (2s), so clamp prefers the fallback.
        const out = computeRetryDelay(withHeaders({ "retry-after-ms": "600000" }), 0);
        assert.equal(out, 2000);
    });
});

describe("computeRetryDelay — retry-after header", () => {
    it("parses seconds", () => {
        assert.equal(computeRetryDelay(withHeaders({ "retry-after": "5" }), 0), 5000);
    });

    it("parses an HTTP-date as an absolute moment", () => {
        const future = new Date(Date.now() + 10_000).toUTCString();
        const out = computeRetryDelay(withHeaders({ "retry-after": future }), 0);
        // Timing slack: 10 ± 1 seconds.
        assert.ok(out >= 9000 && out <= 11_000, `got ${out}`);
    });

    it("treats past HTTP-dates as 0", () => {
        const past = new Date(Date.now() - 60_000).toUTCString();
        assert.equal(computeRetryDelay(withHeaders({ "retry-after": past }), 0), 0);
    });

    it("falls back when the header is unparseable", () => {
        assert.equal(computeRetryDelay(withHeaders({ "retry-after": "wat" }), 0), 2000);
    });

    it("retry-after-ms wins when both are set", () => {
        assert.equal(
            computeRetryDelay(withHeaders({ "retry-after-ms": "300", "retry-after": "60" }), 0),
            300,
        );
    });
});
