import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { APICallError } from "@ai-sdk/provider";
import { formatInferenceError } from "./formatInferenceError.js";

function apiError(opts: {
    statusCode?: number;
    url?: string;
    message?: string;
    responseBody?: string;
}): APICallError {
    return new APICallError({
        message: opts.message ?? "Not Found",
        url: opts.url ?? "https://api.example.com/v1/chat/completions",
        requestBodyValues: {},
        statusCode: opts.statusCode ?? 404,
        responseHeaders: {},
        responseBody: opts.responseBody,
    });
}

describe("formatInferenceError", () => {
    it("includes status, message, and URL for an APICallError without a body", () => {
        const out = formatInferenceError(apiError({ statusCode: 404, message: "Not Found" }));
        assert.equal(
            out,
            "The model API answered with 404 Not Found at https://api.example.com/v1/chat/completions",
        );
    });

    it("appends the response body when present", () => {
        const out = formatInferenceError(
            apiError({
                statusCode: 503,
                message: "Service Unavailable",
                responseBody: '{"error":"Model is over capacity, try later"}',
            }),
        );
        assert.ok(out.startsWith("The model API answered with 503 Service Unavailable at "));
        assert.ok(out.includes('"Model is over capacity, try later"'));
    });

    it("truncates long bodies with an ellipsis", () => {
        const long = "x".repeat(800);
        const out = formatInferenceError(apiError({ responseBody: long }));
        const bodyLine = out.split("\n", 2)[1] ?? "";
        assert.equal(bodyLine.length, 401); // 400 chars + 1-char ellipsis
        assert.ok(bodyLine.endsWith("…"));
    });

    it("falls back to err.message for plain Error", () => {
        assert.equal(formatInferenceError(new Error("boom")), "boom");
    });

    it("stringifies non-Error throw values", () => {
        assert.equal(formatInferenceError("nope"), "nope");
        assert.equal(formatInferenceError(42), "42");
        assert.equal(formatInferenceError(null), "null");
    });

    it("treats whitespace-only bodies as absent", () => {
        const out = formatInferenceError(apiError({ responseBody: "   \n\t  " }));
        assert.ok(!out.includes("\n"), "no body line expected");
    });
});
