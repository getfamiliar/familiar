import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    measurePcm16,
    type SpeechActivityClock,
    SpeechActivityDetector,
} from "./speech-activity.js";

/**
 * Base64 PCM16 of a constant-amplitude chunk.
 *
 * @param durationMs Length at 24 kHz.
 * @param amplitude Sample value in -1…1.
 * @returns The chunk.
 */
function chunk(durationMs: number, amplitude: number): string {
    const samples = new Int16Array((24_000 * durationMs) / 1000).fill(
        Math.round(amplitude * 32767),
    );
    return Buffer.from(samples.buffer).toString("base64");
}

/** A manual clock: `advance` runs due timers. */
function fakeClock(): SpeechActivityClock & { advance(ms: number): void } {
    let now = 0;
    let timers: { at: number; action: () => void; id: number }[] = [];
    let nextId = 1;
    return {
        now: () => now,
        setTimeout: (action, delayMs) => {
            const id = nextId++;
            timers.push({ at: now + delayMs, action, id });
            return id;
        },
        clearTimeout: (handle) => {
            timers = timers.filter((timer) => timer.id !== handle);
        },
        advance(ms) {
            const end = now + ms;
            for (;;) {
                const due = timers
                    .filter((timer) => timer.at <= end)
                    .sort((a, b) => a.at - b.at)[0];
                if (due === undefined) {
                    break;
                }
                timers = timers.filter((timer) => timer !== due);
                now = due.at;
                due.action();
            }
            now = end;
        },
    };
}

describe("measurePcm16", () => {
    it("measures loudness and length", () => {
        assert.deepEqual(measurePcm16(chunk(10, 0)), { rms: 0, sampleCount: 240 });
        assert.ok(Math.abs(measurePcm16(chunk(10, -0.5)).rms - 0.5) < 0.001);
    });
});

describe("SpeechActivityDetector", () => {
    it("ignores streamed silence", () => {
        const clock = fakeClock();
        const changes: boolean[] = [];
        const detector = new SpeechActivityDetector(
            (isSpeaking) => changes.push(isSpeaking),
            clock,
        );
        for (let index = 0; index < 50; index++) {
            detector.addChunk(chunk(100, 0.001));
            clock.advance(100);
        }
        assert.deepEqual(changes, []);
    });

    it("speaks while loud audio plays and stops after the pause", () => {
        const clock = fakeClock();
        const changes: { at: number; isSpeaking: boolean }[] = [];
        const detector = new SpeechActivityDetector(
            (isSpeaking) => changes.push({ at: clock.now(), isSpeaking }),
            clock,
        );
        // 1 s of speech arrives at once (faster than real time), then silence.
        for (let index = 0; index < 10; index++) {
            detector.addChunk(chunk(100, 0.3));
        }
        detector.addChunk(chunk(2000, 0));
        clock.advance(3000);
        assert.equal(changes[0]?.isSpeaking, true);
        assert.equal(changes[0]?.at, 0);
        assert.equal(changes[1]?.isSpeaking, false);
        // Ends after the queued second plus the hangover, not when it arrived.
        assert.ok((changes[1]?.at ?? 0) >= 1300 && (changes[1]?.at ?? 0) < 1400);
    });

    it("starts speaking when queued loud audio reaches playback", () => {
        const clock = fakeClock();
        const changes: { at: number; isSpeaking: boolean }[] = [];
        const detector = new SpeechActivityDetector(
            (isSpeaking) => changes.push({ at: clock.now(), isSpeaking }),
            clock,
        );
        detector.addChunk(chunk(500, 0));
        detector.addChunk(chunk(500, 0.3));
        clock.advance(450);
        assert.equal(changes.length, 0);
        clock.advance(100);
        assert.equal(changes[0]?.isSpeaking, true);
    });

    it("stops at once on reset", () => {
        const clock = fakeClock();
        const changes: boolean[] = [];
        const detector = new SpeechActivityDetector(
            (isSpeaking) => changes.push(isSpeaking),
            clock,
        );
        detector.addChunk(chunk(1000, 0.3));
        detector.reset();
        assert.deepEqual(changes, [true, false]);
    });
});
