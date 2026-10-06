import assert from "node:assert/strict";
import { test } from "node:test";
import { PromptPlaceholderConflictError } from "@getfamiliar/shared";
import { PromptPlaceholderRegistry } from "./PromptPlaceholderRegistry.js";

/** A registration with a fixed value. */
function placeholder(name: string) {
    return { name, description: `${name} for tests`, provide: async () => "value" };
}

test("register stores placeholders sorted by name with their plugin id", () => {
    const registry = new PromptPlaceholderRegistry();
    registry.register("jira", placeholder("OPEN_TICKETS"));
    registry.register("mail", placeholder("INBOX_COUNT"));
    assert.deepEqual(
        registry.list().map((entry) => [entry.name, entry.pluginId]),
        [
            ["INBOX_COUNT", "mail"],
            ["OPEN_TICKETS", "jira"],
        ],
    );
    assert.equal(registry.get("OPEN_TICKETS")?.pluginId, "jira");
});

test("register rejects malformed, core and duplicate names", () => {
    const registry = new PromptPlaceholderRegistry();
    registry.register("jira", placeholder("OPEN_TICKETS"));
    for (const name of ["open_tickets", "1ABC", "TOOL_LIST", "OPEN_TICKETS"]) {
        assert.throws(
            () => registry.register("other", placeholder(name)),
            PromptPlaceholderConflictError,
        );
    }
});
