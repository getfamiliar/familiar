import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ToolError } from "@getfamiliar/shared";
import {
    mergeToolErrorsIntoResults,
    stringifyToolError,
} from "./mergeToolErrorsIntoResults.js";

describe("mergeToolErrorsIntoResults", () => {
    it("returns successes verbatim when content has no tool-error blocks", () => {
        const successes = [{ type: "tool-result", toolCallId: "c1", output: { ok: true } }];
        const content = [
            { type: "tool-call", toolCallId: "c1" },
            { type: "tool-result", toolCallId: "c1", output: { ok: true } },
        ];
        assert.deepEqual(mergeToolErrorsIntoResults(successes, content), successes);
    });

    it("appends tool-error blocks from content with stringified errors", () => {
        const successes: unknown[] = [];
        const content = [
            { type: "tool-call", toolCallId: "c1" },
            {
                type: "tool-error",
                toolCallId: "c1",
                toolName: "mail_fetch_body",
                error: new ToolError("MissingMailId", "no mail_id given"),
            },
        ];
        const merged = mergeToolErrorsIntoResults(successes, content);
        assert.equal(merged.length, 1);
        assert.deepEqual(merged[0], {
            type: "tool-error",
            toolCallId: "c1",
            toolName: "mail_fetch_body",
            error: "MissingMailId: no mail_id given",
        });
    });

    it("preserves successes and appends errors when both exist", () => {
        const successes = [{ type: "tool-result", toolCallId: "c1", output: 1 }];
        const content = [
            {
                type: "tool-error",
                toolCallId: "c2",
                toolName: "mail_move",
                error: new ToolError("BadFolder", "got: outbox"),
            },
        ];
        const merged = mergeToolErrorsIntoResults(successes, content);
        assert.equal(merged.length, 2);
        assert.equal((merged[0] as { toolCallId: string }).toolCallId, "c1");
        assert.equal((merged[1] as { toolCallId: string }).toolCallId, "c2");
    });

    it("ignores tool-error entries missing toolCallId or toolName", () => {
        const content = [
            { type: "tool-error", toolCallId: "c1", error: "bare" },
            { type: "tool-error", toolName: "x", error: "bare" },
        ];
        assert.deepEqual(mergeToolErrorsIntoResults([], content), []);
    });

    it("tolerates non-array inputs without throwing", () => {
        assert.deepEqual(mergeToolErrorsIntoResults(undefined, undefined), []);
        assert.deepEqual(mergeToolErrorsIntoResults(null, null), []);
    });
});

describe("stringifyToolError", () => {
    it("renders ToolError as `<code>: <message>`", () => {
        assert.equal(
            stringifyToolError(new ToolError("MissingMailId", "no mail_id given")),
            "MissingMailId: no mail_id given",
        );
    });

    it("appends `(status N)` when ToolError carries a status", () => {
        assert.equal(
            stringifyToolError(new ToolError("ErrorItemNotFound", "gone", 404)),
            "ErrorItemNotFound: gone (status 404)",
        );
    });

    it("falls back to Error.message for non-ToolError throws", () => {
        assert.equal(stringifyToolError(new Error("boom")), "boom");
    });

    it("passes strings through verbatim", () => {
        assert.equal(stringifyToolError("just text"), "just text");
    });

    it("renders nullish errors as a generic label", () => {
        assert.equal(stringifyToolError(undefined), "tool error");
        assert.equal(stringifyToolError(null), "tool error");
    });

    it("JSON-stringifies plain objects", () => {
        assert.equal(stringifyToolError({ code: "X", message: "y" }), '{"code":"X","message":"y"}');
    });
});
