import { strict as assert } from "node:assert";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { BASTION_TOKEN_HEADER } from "@getfamiliar/shared";
import { MockLogger } from "@getfamiliar/shared/testing";
import { HttpServer } from "./HttpServer.js";

const TOKEN = "correct-horse-battery-staple";

describe("HttpServer token authentication", () => {
    const log = new MockLogger();
    const server = new HttpServer({ bindHost: "127.0.0.1", port: 0, log, token: TOKEN });
    let baseUrl = "";

    before(async () => {
        await server.start();
        server.registerPrefix("/ok/", (_req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("hello");
        });
        // Reach into the bound socket for the ephemeral port.
        const address = (
            server as unknown as { server: { address(): AddressInfo } }
        ).server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    after(async () => {
        await server.stop();
    });

    it("rejects a request without the token header", async () => {
        const res = await fetch(`${baseUrl}/ok/`);
        assert.equal(res.status, 401);
        assert.ok(
            log.entries.some((e) => e.level === "warn" && e.msg.includes("GET /ok/")),
            "rejection is logged with method and path",
        );
    });

    it("rejects a wrong token of the same length", async () => {
        const wrong = "x".repeat(TOKEN.length);
        const res = await fetch(`${baseUrl}/ok/`, { headers: { [BASTION_TOKEN_HEADER]: wrong } });
        assert.equal(res.status, 401);
    });

    it("rejects a wrong token of a different length without throwing", async () => {
        const res = await fetch(`${baseUrl}/ok/`, { headers: { [BASTION_TOKEN_HEADER]: "short" } });
        assert.equal(res.status, 401);
    });

    it("answers 401 (not 404) for unknown paths without a token", async () => {
        const res = await fetch(`${baseUrl}/nope/`);
        assert.equal(res.status, 401);
    });

    it("serves the route with the correct token", async () => {
        const res = await fetch(`${baseUrl}/ok/`, { headers: { [BASTION_TOKEN_HEADER]: TOKEN } });
        assert.equal(res.status, 200);
        assert.equal(await res.text(), "hello");
    });

    it("answers 404 for unknown paths with the correct token", async () => {
        const res = await fetch(`${baseUrl}/nope/`, { headers: { [BASTION_TOKEN_HEADER]: TOKEN } });
        assert.equal(res.status, 404);
    });

    it("refuses to construct with an empty token", () => {
        assert.throws(
            () => new HttpServer({ bindHost: "127.0.0.1", port: 0, log, token: "" }),
            /non-empty bastion token/,
        );
    });
});
