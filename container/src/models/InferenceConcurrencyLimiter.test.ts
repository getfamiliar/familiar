import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    InferenceConcurrencyLimiter,
    type ReleaseSlot,
    resolveConcurrencyKey,
} from "./InferenceConcurrencyLimiter.js";

/** Yield until the microtask queue drains. */
async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

describe("InferenceConcurrencyLimiter", () => {
    it("grants up to the limit immediately and queues the rest", async () => {
        const limiter = new InferenceConcurrencyLimiter(() => 2);
        const first = await limiter.acquire("p", 50, undefined);
        await limiter.acquire("p", 50, undefined);
        let isThirdGranted = false;
        const third = limiter.acquire("p", 50, undefined).then((release) => {
            isThirdGranted = true;
            return release;
        });
        await flush();
        assert.equal(isThirdGranted, false);
        assert.equal(limiter.queuedCount("p"), 1);

        first();
        (await third)();
        assert.equal(isThirdGranted, true);
        assert.equal(limiter.runningCount("p"), 1);
    });

    it("serves higher priority first, FIFO within a priority", async () => {
        const limiter = new InferenceConcurrencyLimiter(() => 1);
        const holder = await limiter.acquire("p", 50, undefined);
        const order: string[] = [];
        const enqueue = (name: string, priority: number) =>
            limiter.acquire("p", priority, undefined).then((release) => {
                order.push(name);
                release();
            });
        const all = Promise.all([
            enqueue("low-a", 10),
            enqueue("high", 90),
            enqueue("low-b", 10),
            enqueue("mid", 50),
        ]);
        holder();
        await all;
        assert.deepEqual(order, ["high", "mid", "low-a", "low-b"]);
    });

    it("treats a missing or non-positive limit as unlimited", async () => {
        const limiter = new InferenceConcurrencyLimiter(() => undefined);
        const releases: ReleaseSlot[] = [];
        for (let i = 0; i < 20; i++) {
            releases.push(await limiter.acquire("p", 50, undefined));
        }
        assert.equal(limiter.runningCount("p"), 20);
    });

    it("keys are independent", async () => {
        const limiter = new InferenceConcurrencyLimiter(() => 1);
        await limiter.acquire("a", 50, undefined);
        const other = await limiter.acquire("b", 50, undefined);
        assert.equal(typeof other, "function");
    });

    it("release is idempotent", async () => {
        const limiter = new InferenceConcurrencyLimiter(() => 1);
        const release = await limiter.acquire("p", 50, undefined);
        const queued = limiter.acquire("p", 50, undefined);
        release();
        release();
        await queued;
        assert.equal(limiter.runningCount("p"), 1);
    });

    it("an abort removes a queued request and rejects with the reason", async () => {
        const limiter = new InferenceConcurrencyLimiter(() => 1);
        const holder = await limiter.acquire("p", 50, undefined);
        const controller = new AbortController();
        let waitEndCalls = 0;
        const queued = limiter.acquire("p", 50, controller.signal, {
            onWaitEnd: () => waitEndCalls++,
        });
        controller.abort(new Error("shutdown"));
        await assert.rejects(queued, /shutdown/);
        assert.equal(limiter.queuedCount("p"), 0);
        assert.equal(waitEndCalls, 0);
        holder();
        assert.equal(limiter.runningCount("p"), 0);
    });

    it("reports wait start with queue position and wait end with the waited time", async () => {
        let now = 1_000;
        const limiter = new InferenceConcurrencyLimiter(
            () => 1,
            () => now,
        );
        const holder = await limiter.acquire("p", 50, undefined);
        const events: string[] = [];
        const queued = limiter.acquire("p", 50, undefined, {
            onWaitStart: (position) => events.push(`start ${position}`),
            onWaitEnd: (waitedMs) => events.push(`end ${waitedMs}`),
        });
        now = 4_000;
        holder();
        await queued;
        assert.deepEqual(events, ["start 1", "end 3000"]);
    });

    it("a raised limit applies on the next release", async () => {
        let limit = 1;
        const limiter = new InferenceConcurrencyLimiter(() => limit);
        const holder = await limiter.acquire("p", 50, undefined);
        const second = limiter.acquire("p", 50, undefined);
        const third = limiter.acquire("p", 50, undefined);
        limit = 3;
        holder();
        await Promise.all([second, third]);
        assert.equal(limiter.runningCount("p"), 2);
    });

    it("a raised limit admits queued requests before a newcomer", async () => {
        let limit = 1;
        const limiter = new InferenceConcurrencyLimiter(() => limit);
        await limiter.acquire("p", 50, undefined);
        const order: string[] = [];
        const queued = limiter.acquire("p", 50, undefined).then(() => order.push("queued"));
        limit = 3;
        const newcomer = limiter.acquire("p", 50, undefined).then(() => order.push("newcomer"));
        await Promise.all([queued, newcomer]);
        assert.deepEqual(order, ["queued", "newcomer"]);
        assert.equal(limiter.runningCount("p"), 3);
    });
});

describe("resolveConcurrencyKey", () => {
    it("prefers the model-specific key over the provider key", () => {
        const limits = { deepseek: 4, "deepseek/deepseek-v4-pro": 1 };
        assert.equal(
            resolveConcurrencyKey("deepseek", "deepseek-v4-pro", limits),
            "deepseek/deepseek-v4-pro",
        );
        assert.equal(resolveConcurrencyKey("deepseek", "deepseek-v4-flash", limits), "deepseek");
    });

    it("handles model ids that contain slashes", () => {
        const limits = { "featherless/zai-org/GLM-5.1": 1 };
        assert.equal(
            resolveConcurrencyKey("featherless", "zai-org/GLM-5.1", limits),
            "featherless/zai-org/GLM-5.1",
        );
    });

    it("returns null when nothing is configured", () => {
        assert.equal(resolveConcurrencyKey("openai", "gpt-5", {}), null);
    });
});
