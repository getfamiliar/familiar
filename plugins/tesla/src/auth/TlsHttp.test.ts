import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectCookies, type TlsResponse } from "./TlsHttp.js";

describe("collectCookies", () => {
    it("reduces set-cookie headers to a Cookie header value", () => {
        const response = {
            status: 200,
            headers: {
                "set-cookie": [
                    "tesla-auth.sid=abc123; Path=/; HttpOnly; Secure; SameSite=Lax",
                    "_csrf=zzz; Path=/",
                ],
            },
            body: "",
        } satisfies TlsResponse;
        assert.equal(collectCookies(response), "tesla-auth.sid=abc123; _csrf=zzz");
    });

    it("accepts a single non-array set-cookie header", () => {
        const response = {
            status: 200,
            headers: { "set-cookie": "only=one; Path=/" },
            body: "",
        } as unknown as TlsResponse;
        assert.equal(collectCookies(response), "only=one");
    });

    it("returns an empty string when the response set no cookie", () => {
        assert.equal(collectCookies({ status: 200, headers: {}, body: "" }), "");
    });
});
