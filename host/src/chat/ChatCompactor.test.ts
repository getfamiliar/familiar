import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { type CompactionRow, formatTranscript, selectCompactionBatch } from "./ChatCompactor.js";

describe("selectCompactionBatch", () => {
    it("returns an empty batch when no row falls outside the keep window", () => {
        const rows = makeRows([
            { id: "5", role: "assistant", text: "fifth", at: "2026-05-22T10:05:00Z" },
            { id: "4", role: "user", text: "fourth", at: "2026-05-22T10:04:00Z" },
            { id: "3", role: "assistant", text: "third", at: "2026-05-22T10:03:00Z" },
        ]);
        const batch = selectCompactionBatch(rows, 1000);
        assert.deepEqual(batch.ids, []);
        assert.equal(batch.transcript, "");
    });

    it("puts the boundary row and everything older into the batch", () => {
        // Each text is exactly 10 bytes. keepUncompactedBytes=25 admits
        // the first two newest rows (10 + 10 = 20 ≤ 25); the third row
        // would push to 30, so it and everything older get compacted.
        const rows = makeRows([
            { id: "5", role: "assistant", text: "AAAAAAAAAA", at: "2026-05-22T10:05:00Z" },
            { id: "4", role: "user", text: "BBBBBBBBBB", at: "2026-05-22T10:04:00Z" },
            { id: "3", role: "assistant", text: "CCCCCCCCCC", at: "2026-05-22T10:03:00Z" },
            { id: "2", role: "user", text: "DDDDDDDDDD", at: "2026-05-22T10:02:00Z" },
            { id: "1", role: "assistant", text: "EEEEEEEEEE", at: "2026-05-22T10:01:00Z" },
        ]);
        const batch = selectCompactionBatch(rows, 25);

        // Captured ids returned in chronological order (oldest first).
        assert.deepEqual(batch.ids, ["1", "2", "3"]);
        // Transcript joins the captured rows in chronological order.
        assert.equal(
            batch.transcript,
            "assistant: EEEEEEEEEE\n\nuser: DDDDDDDDDD\n\nassistant: CCCCCCCCCC",
        );
        // Boundary timestamp is the newest compacted row — the one
        // that pushed past the keep window. The summary inserted with
        // this timestamp lands immediately before the oldest kept
        // message under the read path's chronological sort.
        assert.equal(batch.boundaryCreatedAt.toISOString(), "2026-05-22T10:03:00.000Z");
        // maxId is the highest compacted id, used as the idempotency-
        // key suffix so two near-simultaneous triggers collapse to one
        // event and a later batch (after new messages) gets a fresh key.
        assert.equal(batch.maxId, "3");
    });

    it("treats the keep window as inclusive at the boundary", () => {
        // First two rows fit exactly at the budget (10 + 10 = 20). The
        // next row tips us past, so it gets compacted.
        const rows = makeRows([
            { id: "3", role: "user", text: "AAAAAAAAAA", at: "2026-05-22T10:03:00Z" },
            { id: "2", role: "user", text: "BBBBBBBBBB", at: "2026-05-22T10:02:00Z" },
            { id: "1", role: "user", text: "C", at: "2026-05-22T10:01:00Z" },
        ]);
        const batch = selectCompactionBatch(rows, 20);
        assert.deepEqual(batch.ids, ["1"]);
    });

    it("counts utf-8 bytes, not characters", () => {
        // "✓" is 3 bytes in UTF-8. Three of them = 9 bytes. With
        // keepUncompactedBytes=8, the third one pushes us past the
        // window and gets compacted.
        const rows = makeRows([
            { id: "3", role: "user", text: "✓", at: "2026-05-22T10:03:00Z", byteSize: 3 },
            { id: "2", role: "user", text: "✓", at: "2026-05-22T10:02:00Z", byteSize: 3 },
            { id: "1", role: "user", text: "✓", at: "2026-05-22T10:01:00Z", byteSize: 3 },
        ]);
        const batch = selectCompactionBatch(rows, 8);
        assert.deepEqual(batch.ids, ["1"]);
    });

    it("compares ids as bigints so a 19-char id beats a 17-char id", () => {
        // postgres bigserial can return ids like "9999999999999999" (16
        // chars) and "10000000000000000" (17 chars); lexicographic
        // comparison would put the shorter string first. BigInt is the
        // right semantic.
        const rows = makeRows([
            {
                id: "10000000000000000",
                role: "user",
                text: "X".repeat(100),
                at: "2026-05-22T10:03:00Z",
            },
            {
                id: "9999999999999999",
                role: "user",
                text: "X".repeat(100),
                at: "2026-05-22T10:02:00Z",
            },
        ]);
        const batch = selectCompactionBatch(rows, 50);
        assert.equal(batch.maxId, "10000000000000000");
    });
});

describe("formatTranscript", () => {
    it("joins rows by blank lines and prefixes each with its role", () => {
        const rows = makeRows([
            { id: "1", role: "user", text: "hi", at: "2026-05-22T10:00:00Z" },
            { id: "2", role: "assistant", text: "hello", at: "2026-05-22T10:00:01Z" },
            { id: "3", role: "user", text: "how are you?", at: "2026-05-22T10:00:02Z" },
        ]);
        assert.equal(formatTranscript(rows), "user: hi\n\nassistant: hello\n\nuser: how are you?");
    });

    it("returns an empty string for an empty list", () => {
        assert.equal(formatTranscript([]), "");
    });
});

function makeRows(
    specs: ReadonlyArray<{
        id: string;
        role: "user" | "assistant";
        text: string;
        at: string;
        byteSize?: number;
    }>,
): CompactionRow[] {
    return specs.map((s) => ({
        id: s.id,
        role: s.role,
        textContent: s.text,
        createdAt: new Date(s.at),
        byteSize: s.byteSize ?? Buffer.byteLength(s.text, "utf8"),
    }));
}
