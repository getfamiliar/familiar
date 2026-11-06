import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    CallTranscript,
    formatTranscript,
    type TranscriptFragment,
    type TranscriptTurn,
} from "./CallTranscript.js";

/**
 * Shorthand for a fragment.
 *
 * @param speaker Who.
 * @param delta Text.
 * @param startMs Audio offset.
 * @returns The fragment (200 ms long).
 */
function fragment(
    speaker: "user" | "assistant",
    delta: string,
    startMs: number,
): TranscriptFragment {
    return { speaker, delta, startMs, endMs: startMs + 200 };
}

describe("CallTranscript", () => {
    it("joins a speaker's fragments and finishes the turn after a pause", () => {
        const finished: TranscriptTurn[] = [];
        const transcript = new CallTranscript((turn) => finished.push(turn));
        transcript.add(fragment("user", " Hallo", 800));
        transcript.add(fragment("user", "! Wie", 1000));
        transcript.add(fragment("user", " geht's?", 1200));
        assert.deepEqual(finished, []);
        transcript.add(fragment("assistant", " Gut,", 1600));
        // The user's last word ended at 1400, 3000 is more than 1.5 s later;
        // the assistant's own pause (1800 → 3000) is shorter, so it continues.
        transcript.add(fragment("assistant", " danke.", 3000));
        assert.deepEqual(finished, [{ speaker: "user", text: "Hallo! Wie geht's?", startMs: 800 }]);
        transcript.flush();
        assert.deepEqual(finished[1], { speaker: "assistant", text: "Gut, danke.", startMs: 1600 });
    });

    it("keeps interleaved speakers apart (full duplex)", () => {
        const transcript = new CallTranscript(() => {});
        transcript.add(fragment("assistant", " Ich schaue", 1000));
        transcript.add(fragment("user", " Moment", 1100));
        transcript.add(fragment("assistant", " nach.", 1200));
        assert.deepEqual(transcript.recent(10), [
            { speaker: "assistant", text: "Ich schaue nach.", startMs: 1000 },
            { speaker: "user", text: "Moment", startMs: 1100 },
        ]);
    });

    it("includes open utterances in recent() and limits the count", () => {
        const transcript = new CallTranscript(() => {});
        transcript.add(fragment("user", " eins", 0));
        transcript.add(fragment("assistant", " zwei", 5000));
        transcript.add(fragment("user", " drei", 10_000));
        assert.deepEqual(
            transcript.recent(2).map((turn) => turn.text),
            ["zwei", "drei"],
        );
    });

    it("formats turns as labelled lines", () => {
        assert.equal(
            formatTranscript([
                { speaker: "user", text: "Hallo", startMs: 0 },
                { speaker: "assistant", text: "Hi", startMs: 1 },
            ]),
            "User: Hallo\nAssistant: Hi",
        );
    });
});
