import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { EmitHandle, NewEvent } from "@getfamiliar/shared";
import { MockLogger } from "@getfamiliar/shared/testing";
import { BRIEFING_CACHE_MS, BriefingProvider } from "./BriefingProvider.js";

/** A briefing provider over a fake bus whose runs the test settles. */
function fakeProvider(): {
    provider: BriefingProvider;
    emitted: { event: NewEvent; resolve(text: string): void; reject(error: Error): void }[];
    clock: { now: number };
} {
    const emitted: { event: NewEvent; resolve(text: string): void; reject(error: Error): void }[] =
        [];
    const clock = { now: Date.parse("2026-05-19T16:43:12Z") };
    const provider = new BriefingProvider({
        events: {
            emit: async (event: NewEvent): Promise<EmitHandle> => {
                let resolve: (text: string) => void = () => {};
                let reject: (error: Error) => void = () => {};
                const settled = new Promise<string>((res, rej) => {
                    resolve = res;
                    reject = rej;
                });
                emitted.push({ event, resolve, reject });
                return { id: `ev-${emitted.length}`, settled };
            },
        },
        log: new MockLogger(),
        timezone: () => "Europe/Berlin",
        now: () => new Date(clock.now),
    });
    return { provider, emitted, clock };
}

/** Let the emit promise chain run. */
async function tick(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

describe("BriefingProvider", () => {
    it("emits a voice:briefing event below chat priority", async () => {
        const { provider, emitted } = fakeProvider();
        const briefing = provider.get("call-1");
        await tick();
        const [entry] = emitted;
        assert.ok(entry !== undefined);
        assert.equal(entry.event.topic, "voice:briefing");
        assert.equal(entry.event.isExactTopic, true);
        assert.equal(entry.event.privileged, true);
        assert.equal(entry.event.priority, 90);
        assert.match(entry.event.prompt, /Tuesday, 2026-05-19T18:43:12 in timezone Europe\/Berlin/);
        entry.resolve("  Heute frei.  ");
        assert.equal(await briefing, "Heute frei.");
    });

    it("shares a running briefing and reuses it until it is 30 minutes old", async () => {
        const { provider, emitted, clock } = fakeProvider();
        const first = provider.get("call-1");
        const second = provider.get("call-2");
        await tick();
        assert.equal(emitted.length, 1);
        emitted[0]?.resolve("Heute frei.");
        assert.equal(await first, "Heute frei.");
        assert.equal(await second, "Heute frei.");

        clock.now += BRIEFING_CACHE_MS - 1000;
        assert.equal(await provider.get("call-3"), "Heute frei.");
        assert.equal(emitted.length, 1);

        clock.now += 2000;
        const fresh = provider.get("call-4");
        await tick();
        assert.equal(emitted.length, 2);
        emitted[1]?.resolve("Morgen Zahnarzt.");
        assert.equal(await fresh, "Morgen Zahnarzt.");
    });

    it("does not cache a failed or empty briefing", async () => {
        const { provider, emitted } = fakeProvider();
        const failed = provider.get("call-1");
        await tick();
        emitted[0]?.reject(new Error("model over capacity"));
        await assert.rejects(failed, /over capacity/);

        const empty = provider.get("call-2");
        await tick();
        assert.equal(emitted.length, 2);
        emitted[1]?.resolve("   ");
        await assert.rejects(empty, /returned no text/);

        const retry = provider.get("call-3");
        await tick();
        assert.equal(emitted.length, 3);
        emitted[2]?.resolve("Heute frei.");
        assert.equal(await retry, "Heute frei.");
    });
});
