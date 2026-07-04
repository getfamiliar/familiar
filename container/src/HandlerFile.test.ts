import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { HandlerFile } from "./HandlerFile.js";

const CONFIG_VAR = "FAMILIAR_CONTAINER_CONFIG";

let root: string;
let previousConfig: string | undefined;

beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "handler-file-test-"));
    HandlerFile.setWorkspaceRoot(root);
    previousConfig = process.env[CONFIG_VAR];
});

afterEach(() => {
    if (previousConfig === undefined) {
        delete process.env[CONFIG_VAR];
    } else {
        process.env[CONFIG_VAR] = previousConfig;
    }
});

/** Set the passed-config blob the writable-path gate reads via `PassedConfig`. */
function setWritablePaths(globs: string[]): void {
    process.env[CONFIG_VAR] = JSON.stringify({ "core.writablePaths": globs });
}

/** Write a handler file at a workspace-relative path, creating parents. */
function touch(rel: string, contents = "# stub handler\n"): void {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
}

test("load refuses a handler whose leaf lives under a writable path", () => {
    setWritablePaths(["wiki/**"]);
    touch("wiki/index.md");

    assert.throws(() => HandlerFile.load("wiki", "index"), /core\.writablePaths/);
});

test("load still resolves a normal handler outside writable paths", () => {
    setWritablePaths(["wiki/**"]);
    touch("mail/index.md");

    const handler = HandlerFile.load("mail", "index");
    assert.equal(handler.relativePath, "mail/index.md");
});

test("load resolves wiki handlers when no writable paths are configured", () => {
    delete process.env[CONFIG_VAR];
    touch("wiki/index.md");

    const handler = HandlerFile.load("wiki", "index");
    assert.equal(handler.relativePath, "wiki/index.md");
});
