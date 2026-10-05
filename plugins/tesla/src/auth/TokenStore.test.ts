import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { TokenStore } from "./TokenStore.js";

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "familiar-tesla-tokens-"));
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

describe("TokenStore.read", () => {
    it("returns null when no token file exists", async () => {
        const store = new TokenStore(path.join(scratch, "auth.json"));
        assert.equal(await store.read(), null);
    });

    it("names the chown fix when the token file is not readable", {
        // root reads any file regardless of mode, so the EACCES can't be provoked.
        skip: process.getuid?.() === 0,
    }, async () => {
        const file = path.join(scratch, "auth.json");
        writeFileSync(file, "{}");
        chmodSync(file, 0o000);
        const store = new TokenStore(file);
        await assert.rejects(store.read(), (err: Error) => {
            assert.match(err.message, /not readable \(EACCES\)/);
            assert.match(err.message, /sudo chown "\$\(id -u\):\$\(id -g\)"/);
            assert.ok(err.message.includes(file));
            return true;
        });
    });
});
