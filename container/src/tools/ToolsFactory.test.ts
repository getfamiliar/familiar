import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ToolsFactory } from "./ToolsFactory.js";

/**
 * The ToolsFactory wraps `parseExpression` and `evaluate` errors with
 * a fixed prefix so the chat-facing error message points the user at
 * the `tools:` frontmatter attribute rather than dumping an opaque
 * "unexpected character" / "unknown group" message.
 */
describe("ToolsFactory — error wrapping", () => {
    it("wraps a parse error with the frontmatter-context prefix", () => {
        assert.throws(
            () => ToolsFactory.build({ toolsExpression: "system ö fetch" }),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.match(
                    err.message,
                    /^Cannot parse tools frontmatter attribute "system ö fetch", aborting: /,
                );
                assert.match(err.message, /unexpected character/);
                return true;
            },
        );
    });

    it("wraps an evaluator error (unknown group) with the resolve prefix", () => {
        assert.throws(
            () => ToolsFactory.build({ toolsExpression: "thisgroupdoesnotexist" }),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.match(
                    err.message,
                    /^Cannot resolve tools frontmatter attribute "thisgroupdoesnotexist", aborting: /,
                );
                return true;
            },
        );
    });

    it("preserves the original error as `cause`", () => {
        try {
            ToolsFactory.build({ toolsExpression: "system ö fetch" });
            assert.fail("expected throw");
        } catch (err) {
            assert.ok(err instanceof Error);
            assert.ok(err.cause instanceof Error);
            assert.match((err.cause as Error).message, /unexpected character/);
        }
    });
});
