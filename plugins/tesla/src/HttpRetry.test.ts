import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchWithRetry, isConnectionError, withConnectionRetry } from "./HttpRetry.js";

/** An `ErrnoException`-shaped error, as `node:https` raises. */
function errno(code: string): Error {
    return Object.assign(new Error(`socket ${code}`), { code });
}

describe("isConnectionError", () => {
    it("sees a bare errno code", () => {
        assert.equal(isConnectionError(errno("ECONNRESET")), true);
    });

    it("sees through an AggregateError, whose own message is empty", () => {
        const err = new AggregateError([errno("ETIMEDOUT"), errno("ETIMEDOUT")], "");
        assert.equal(isConnectionError(err), true);
    });

    it("sees through fetch's opaque wrapper via `cause`", () => {
        // This is exactly what `fetch` throws on a dropped connection.
        const err = new TypeError("fetch failed", { cause: errno("ENOTFOUND") });
        assert.equal(isConnectionError(err), true);
    });

    it("does not claim an application error is a connection error", () => {
        assert.equal(isConnectionError(new Error("vehicle unavailable")), false);
        assert.equal(isConnectionError(errno("ENOENT")), false);
        assert.equal(isConnectionError("nope"), false);
    });
});

describe("withConnectionRetry", () => {
    it("retries a connection failure and returns the eventual success", async () => {
        let calls = 0;
        const result = await withConnectionRetry(async () => {
            calls += 1;
            if (calls < 3) {
                throw errno("ETIMEDOUT");
            }
            return "ok";
        });
        assert.equal(result, "ok");
        assert.equal(calls, 3);
    });

    it("gives up after the final attempt and rethrows the last error", async () => {
        let calls = 0;
        await assert.rejects(
            () =>
                withConnectionRetry(async () => {
                    calls += 1;
                    throw errno("ECONNREFUSED");
                }),
            /ECONNREFUSED/,
        );
        assert.equal(calls, 4, "one initial attempt plus three retries");
    });

    it("does not retry a non-connection error", async () => {
        let calls = 0;
        await assert.rejects(
            () =>
                withConnectionRetry(async () => {
                    calls += 1;
                    throw new Error("401 unauthorized");
                }),
            /401/,
        );
        assert.equal(calls, 1, "an HTTP-level failure must not be retried");
    });
});

describe("fetchWithRetry", () => {
    it("names the host instead of surfacing a bare 'fetch failed'", async () => {
        const original = globalThis.fetch;
        globalThis.fetch = (async () => {
            throw new TypeError("fetch failed", { cause: errno("ETIMEDOUT") });
        }) as typeof globalThis.fetch;
        try {
            await assert.rejects(
                () => fetchWithRetry("https://owner-api.teslamotors.com/api/1/products"),
                (err: Error) => {
                    assert.match(err.message, /could not reach owner-api\.teslamotors\.com/);
                    assert.match(err.message, /ETIMEDOUT/);
                    return true;
                },
            );
        } finally {
            globalThis.fetch = original;
        }
    });

    it("returns a non-2xx response rather than treating it as a failure", async () => {
        const original = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            return new Response("nope", { status: 412 });
        }) as typeof globalThis.fetch;
        try {
            const res = await fetchWithRetry("https://owner-api.teslamotors.com/api/1/vehicles");
            assert.equal(res.status, 412);
            assert.equal(calls, 1, "an HTTP answer must not be retried");
        } finally {
            globalThis.fetch = original;
        }
    });
});
