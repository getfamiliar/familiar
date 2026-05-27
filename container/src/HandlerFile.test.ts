import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { HandlerFile } from "./HandlerFile.js";

let root: string;
let previousWritablePaths: string | undefined;

beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "handler-file-test-"));
    HandlerFile.setWorkspaceRoot(root);
    previousWritablePaths = process.env.CORE_WRITABLE_PATHS;
});

afterEach(() => {
    if (previousWritablePaths === undefined) {
        delete process.env.CORE_WRITABLE_PATHS;
    } else {
        process.env.CORE_WRITABLE_PATHS = previousWritablePaths;
    }
});

/** Write a handler file at a workspace-relative path, creating parents. */
function touch(rel: string, contents = "# stub handler\n"): void {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
}

test("load refuses a handler whose leaf lives under a writable path", () => {
    process.env.CORE_WRITABLE_PATHS = JSON.stringify(["wiki/**"]);
    touch("wiki/index.md");

    assert.throws(() => HandlerFile.load("wiki", "index"), /core\.writablePaths/);
});

test("load still resolves a normal handler outside writable paths", () => {
    process.env.CORE_WRITABLE_PATHS = JSON.stringify(["wiki/**"]);
    touch("mail/index.md");

    const handler = HandlerFile.load("mail", "index");
    assert.equal(handler.relativePath, "mail/index.md");
});

test("load resolves wiki handlers when no writable paths are configured", () => {
    delete process.env.CORE_WRITABLE_PATHS;
    touch("wiki/index.md");

    const handler = HandlerFile.load("wiki", "index");
    assert.equal(handler.relativePath, "wiki/index.md");
});
