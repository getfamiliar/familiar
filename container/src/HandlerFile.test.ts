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

test("load resolves handlers living next to a skill (intended, e.g. skills/memory/save.md)", () => {
    delete process.env[CONFIG_VAR];
    touch("skills/memory/SKILL.md", "# memory skill\n");
    touch("skills/memory/save.md", "# save handler\n");

    const handler = HandlerFile.load("skills:memory", "save");
    assert.equal(handler.relativePath, "skills/memory/save.md");
});

test("systemPrompt accepts default, none and a workspace .md path", () => {
    delete process.env[CONFIG_VAR];
    for (const value of ["default", "none", "prompts/minimal.md"]) {
        touch("mail/index.md", `---\nsystemPrompt: ${value}\n---\nbody\n`);
        assert.equal(HandlerFile.load("mail", "index").header.systemPrompt, value);
    }
});

test("systemPrompt rejects the retired modes and unsafe paths", () => {
    delete process.env[CONFIG_VAR];
    for (const value of ["full", "only-soul", "../outside.md", "/abs.md", "prompts/x.txt"]) {
        touch("mail/index.md", `---\nsystemPrompt: ${value}\n---\nbody\n`);
        assert.throws(() => HandlerFile.load("mail", "index"), /systemPrompt/);
    }
});

test("skills parses from a comma string and a YAML list", () => {
    touch("mail/index.md", "---\nskills: jira, tesla\n---\nbody\n");
    touch("chat/index.md", "---\nskills:\n  - reflection\n  - whoop\n---\nbody\n");

    assert.deepEqual(HandlerFile.load("mail", "index").header.skills, ["jira", "tesla"]);
    assert.deepEqual(HandlerFile.load("chat", "index").header.skills, ["reflection", "whoop"]);
});

test("skills rejects path-like entries", () => {
    touch("mail/index.md", "---\nskills: ../secret\n---\nbody\n");

    assert.throws(() => HandlerFile.load("mail", "index"), /header field "skills"/);
});

test("a child handler's skills replace its parent's", () => {
    touch("chat/index.md", "---\nskills: memory\n---\nparent\n");
    touch("chat/telegram/index.md", "---\nskills: reflection\n---\nchild\n");
    touch("chat/whatsapp/index.md", "child without skills\n");

    assert.deepEqual(HandlerFile.load("chat:telegram", "index").header.skills, ["reflection"]);
    assert.deepEqual(HandlerFile.load("chat:whatsapp", "index").header.skills, ["memory"]);
});
