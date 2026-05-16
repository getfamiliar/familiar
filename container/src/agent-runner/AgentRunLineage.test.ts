import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunBus, AgentRunRow } from "@getfamiliar/shared";
import { fetchAncestorChain } from "./AgentRunLineage.js";

/** Build a minimal AgentRunRow stub keyed by id with a chosen parent pointer. */
function row(id: string, parentAgentrunId: string | null, prompt = "p"): AgentRunRow {
    return {
        id,
        eventId: "1",
        parentAgentrunId,
        topic: "t",
        handler: "h",
        model: null,
        priority: 50,
        state: "done",
        prompt,
        systemPrompt: null,
        payload: null,
        result: null,
        resultText: null,
        error: null,
        privileged: false,
        retryCount: 0,
        notBefore: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    } as AgentRunRow;
}

/** In-memory AgentRunBus stub satisfying `Pick<AgentRunBus, "getById">`. */
function fakeBus(rows: readonly AgentRunRow[]): Pick<AgentRunBus, "getById"> {
    const map = new Map(rows.map((r) => [r.id, r]));
    return {
        async getById(id: string): Promise<AgentRunRow | undefined> {
            return map.get(id);
        },
    };
}

test("returns empty for null parent id", async () => {
    const out = await fetchAncestorChain(fakeBus([]), null);
    assert.deepEqual(out, []);
});

test("returns the immediate parent when no grandparent exists", async () => {
    const bus = fakeBus([row("10", null, "root-prompt")]);
    const out = await fetchAncestorChain(bus, "10");
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "10");
});

test("returns ancestors in root-first order", async () => {
    const bus = fakeBus([
        row("10", null, "root"), // root
        row("11", "10", "mid"), // child
        row("12", "11", "leaf"), // grandchild
    ]);
    const out = await fetchAncestorChain(bus, "12");
    assert.deepEqual(
        out.map((r) => r.prompt),
        ["root", "mid", "leaf"],
    );
});

test("stops at a missing ancestor without throwing", async () => {
    const bus = fakeBus([row("11", "missing-id", "mid")]);
    const out = await fetchAncestorChain(bus, "11");
    assert.deepEqual(
        out.map((r) => r.id),
        ["11"],
    );
});

test("honours the max-depth cap", async () => {
    const bus = fakeBus([
        row("a", "b"),
        row("b", "c"),
        row("c", "d"),
        row("d", "e"),
        row("e", "f"),
        row("f", null),
    ]);
    const out = await fetchAncestorChain(bus, "a", 3);
    assert.equal(out.length, 3);
    // Root-first; with cap=3 starting from `a`, we get a, b, c — then truncated.
    assert.deepEqual(
        out.map((r) => r.id),
        ["c", "b", "a"],
    );
});
