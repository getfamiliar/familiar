import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ToolsFactory } from "./ToolsFactory.js";

/**
 * The ToolsFactory wraps `resolveTools` errors with a fixed prefix so
 * the chat-facing error message points the user at the `tools:`
 * frontmatter attribute rather than dumping an opaque "unknown group"
 * message.
 */
describe("ToolsFactory — error wrapping", () => {
    it("wraps an unknown-group error with the resolve prefix", () => {
        assert.throws(
            () => ToolsFactory.build({ tools: ["thisgroupdoesnotexist"] }),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.match(
                    err.message,
                    /^Cannot resolve tools frontmatter attribute \["thisgroupdoesnotexist"\], aborting: /,
                );
                assert.match(err.message, /unknown group: thisgroupdoesnotexist/);
                return true;
            },
        );
    });

    it("preserves the original error as `cause`", () => {
        try {
            ToolsFactory.build({ tools: ["thisgroupdoesnotexist"] });
            assert.fail("expected throw");
        } catch (err) {
            assert.ok(err instanceof Error);
            assert.ok(err.cause instanceof Error);
            assert.match((err.cause as Error).message, /unknown group: thisgroupdoesnotexist/);
        }
    });

    it("an omitted `tools:` falls back to the implicit core default (empty here)", () => {
        // No tools registered (no chat/parent/bus), so `core` is empty —
        // but the call must succeed rather than throw.
        const out = ToolsFactory.build({});
        assert.deepEqual(Object.keys(out), []);
    });
});
