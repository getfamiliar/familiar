import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ChatMessage } from "@getfamiliar/shared";
import { buildHistoryInput, HISTORY_INPUT_MAX_CHARS } from "./LiveCall.js";

/**
 * A chat message of an earlier call.
 *
 * @param id Message id.
 * @param text Text.
 * @returns The message (alternating roles by id parity).
 */
function message(id: number, text: string): ChatMessage {
    return {
        id: String(id),
        eventId: "ev-1",
        role: id % 2 === 0 ? "assistant" : "user",
        textContent: text,
        createdAt: new Date(0),
        deliveredAt: null,
    };
}

describe("buildHistoryInput", () => {
    it("is empty without messages", () => {
        assert.deepEqual(buildHistoryInput([]), []);
        assert.deepEqual(buildHistoryInput([message(1, "  ")]), []);
    });

    it("keeps the newest messages within the character budget, oldest first", () => {
        const long = "x".repeat(HISTORY_INPUT_MAX_CHARS / 3);
        const input = buildHistoryInput([
            message(1, `oldest ${long}`),
            message(2, `older ${long}`),
            message(3, `newer ${long}`),
            message(4, "newest"),
        ]);
        assert.deepEqual(
            input.map((entry) => [entry.role, entry.content[0].text.split(" ")[0]]),
            [
                ["developer", "The"],
                ["assistant", "older"],
                ["user", "newer"],
                ["assistant", "newest"],
            ],
        );
        assert.equal(input[3]?.content[0].type, "output_text");
        assert.equal(input[2]?.content[0].type, "input_text");
    });
});
