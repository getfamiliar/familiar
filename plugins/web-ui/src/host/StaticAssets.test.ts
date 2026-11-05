import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { WebUiEnv } from "@getfamiliar/shared";
import { Hono } from "hono";
import { StaticAssets } from "./StaticAssets.js";

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-web-ui-"));
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

/**
 * A Hono app serving `clientDir` through {@link StaticAssets}.
 *
 * @param clientDir Directory to serve.
 * @returns The app.
 */
function serve(clientDir: string): Hono<WebUiEnv> {
    const assets = new StaticAssets(clientDir);
    const app = new Hono<WebUiEnv>();
    app.all("*", (c) => assets.handle(c));
    return app;
}

/** Write a minimal build output into `<scratch>/client`. */
function writeBundle(): string {
    const clientDir = path.join(scratch, "client");
    mkdirSync(path.join(clientDir, "assets"), { recursive: true });
    writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><div id=root></div>");
    writeFileSync(path.join(clientDir, "assets", "index-abc.js"), "console.log(1)");
    writeFileSync(path.join(scratch, "secret.txt"), "outside");
    return clientDir;
}

describe("StaticAssets", () => {
    it("serves files with content type and cache headers", async () => {
        const app = serve(writeBundle());
        const js = await app.request("/assets/index-abc.js");
        assert.equal(js.status, 200);
        assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
        assert.match(js.headers.get("cache-control") ?? "", /immutable/);
        assert.equal(await js.text(), "console.log(1)");

        const index = await app.request("/");
        assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
        assert.equal(index.headers.get("cache-control"), "no-cache");
    });

    it("falls back to index.html for client-side routes, not for missing files", async () => {
        const app = serve(writeBundle());
        const route = await app.request("/settings/profile");
        assert.equal(route.status, 200);
        assert.match(await route.text(), /id=root/);
        assert.equal((await app.request("/assets/missing.js")).status, 404);
        assert.equal((await app.request("/", { method: "POST" })).status, 404);
    });

    it("refuses paths escaping the client dir", async () => {
        const app = serve(writeBundle());
        for (const attempt of ["/..%2Fsecret.txt", "/assets/..%2F..%2Fsecret.txt", "/%00"]) {
            const res = await app.request(attempt);
            assert.notEqual(await res.text(), "outside", attempt);
        }
        assert.equal((await app.request("/..%2Fsecret.txt")).status, 404);
    });

    it("explains a missing bundle", async () => {
        const app = serve(path.join(scratch, "never-built"));
        const res = await app.request("/");
        assert.equal(res.status, 500);
        assert.match(await res.text(), /npm run build/);
    });
});
