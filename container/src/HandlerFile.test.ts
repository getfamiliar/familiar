import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { HandlerFile, handlerSerialKey } from "./HandlerFile.js";

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

    assert.throws(() => HandlerFile.load("wiki", { isExactTopic: true }), /core\.writablePaths/);
});

test("load still resolves a normal handler outside writable paths", () => {
    setWritablePaths(["wiki/**"]);
    touch("mail/index.md");

    const handler = HandlerFile.load("mail", { isExactTopic: true });
    assert.equal(handler.relativePath, "mail/index.md");
});

test("load resolves wiki handlers when no writable paths are configured", () => {
    delete process.env[CONFIG_VAR];
    touch("wiki/index.md");

    const handler = HandlerFile.load("wiki", { isExactTopic: true });
    assert.equal(handler.relativePath, "wiki/index.md");
});

test("load resolves handlers living next to a skill (intended, e.g. skills/memory/save.md)", () => {
    delete process.env[CONFIG_VAR];
    touch("skills/memory/SKILL.md", "# memory skill\n");
    touch("skills/memory/save.md", "# save handler\n");

    const handler = HandlerFile.load("skills:memory:save", { isExactTopic: true });
    assert.equal(handler.relativePath, "skills/memory/save.md");
});

test("systemPrompt accepts default, none and a workspace .md path", () => {
    delete process.env[CONFIG_VAR];
    for (const value of ["default", "none", "prompts/minimal.md"]) {
        touch("mail/index.md", `---\nsystemPrompt: ${value}\n---\nbody\n`);
        assert.equal(HandlerFile.load("mail", { isExactTopic: true }).header.systemPrompt, value);
    }
});

test("systemPrompt rejects the retired modes and unsafe paths", () => {
    delete process.env[CONFIG_VAR];
    for (const value of ["full", "only-soul", "../outside.md", "/abs.md", "prompts/x.txt"]) {
        touch("mail/index.md", `---\nsystemPrompt: ${value}\n---\nbody\n`);
        assert.throws(() => HandlerFile.load("mail", { isExactTopic: true }), /systemPrompt/);
    }
});

test("skills parses from a comma string and a YAML list", () => {
    touch("mail/index.md", "---\nskills: jira, tesla\n---\nbody\n");
    touch("chat/index.md", "---\nskills:\n  - reflection\n  - whoop\n---\nbody\n");

    assert.deepEqual(HandlerFile.load("mail", { isExactTopic: true }).header.skills, [
        "jira",
        "tesla",
    ]);
    assert.deepEqual(HandlerFile.load("chat", { isExactTopic: true }).header.skills, [
        "reflection",
        "whoop",
    ]);
});

test("skills rejects path-like entries", () => {
    touch("mail/index.md", "---\nskills: ../secret\n---\nbody\n");

    assert.throws(() => HandlerFile.load("mail", { isExactTopic: true }), /header field "skills"/);
});

test("only the most specific handler file is loaded — nothing is inherited", () => {
    touch("chat/index.md", "---\nskills: memory\nmodel: parent-model\n---\nparent body\n");
    touch("chat/telegram.md", "---\nskills: reflection\n---\nchild body\n");

    const handler = HandlerFile.load("chat:telegram", { isExactTopic: false });
    assert.equal(handler.relativePath, "chat/telegram.md");
    assert.equal(handler.body, "child body");
    assert.deepEqual(handler.header.skills, ["reflection"]);
    assert.equal(handler.header.model, undefined);
});

test("non-exact topics fall back up the chain to the nearest existing file", () => {
    touch("chat/index.md", "parent body\n");

    const handler = HandlerFile.load("chat:telegram:group", { isExactTopic: false });
    assert.equal(handler.relativePath, "chat/index.md");
    assert.equal(handler.body, "parent body");
});

test("exact topics do not fall back", () => {
    touch("chat/index.md", "parent body\n");

    assert.throws(
        () => HandlerFile.load("chat:telegram", { isExactTopic: true }),
        /Handler not found for topic="chat:telegram"/,
    );
});

test("x.md wins over x/index.md and the loser is reported as shadowed", () => {
    touch("mail/new/ms365.md", "file form\n");
    touch("mail/new/ms365/index.md", "folder form\n");

    const handler = HandlerFile.load("mail:new:ms365", { isExactTopic: true });
    assert.equal(handler.relativePath, "mail/new/ms365.md");
    assert.equal(handler.body, "file form");
    assert.equal(handler.shadowedPath, "mail/new/ms365/index.md");
});

test("the folder form x/index.md resolves when it is the only form", () => {
    touch("mail/new/ms365/index.md", "folder form\n");

    const handler = HandlerFile.load("mail:new:ms365", { isExactTopic: true });
    assert.equal(handler.relativePath, "mail/new/ms365/index.md");
    assert.equal(handler.shadowedPath, null);
});

test("serial: true keys the handler by its own path", () => {
    touch("chat/telegram.md", "---\nserial: true\n---\nbody\n");
    const handler = HandlerFile.load("chat:telegram", { isExactTopic: true });
    assert.equal(handlerSerialKey(handler), "handler:chat/telegram.md");
});

test("serial: <name> keys every handler declaring it by the shared group", () => {
    touch("chat/telegram.md", "---\nserial: chat\n---\nbody\n");
    touch("chat/web.md", "---\nserial: chat\n---\nbody\n");
    const telegram = HandlerFile.load("chat:telegram", { isExactTopic: true });
    const web = HandlerFile.load("chat:web", { isExactTopic: true });
    assert.equal(handlerSerialKey(telegram), "group:chat");
    assert.equal(handlerSerialKey(web), "group:chat");
});

test("serial absent or false runs in parallel", () => {
    touch("mail/index.md", "---\nserial: false\n---\nbody\n");
    touch("cal/index.md", "# no frontmatter\n");
    assert.equal(handlerSerialKey(HandlerFile.load("mail", { isExactTopic: true })), null);
    assert.equal(handlerSerialKey(HandlerFile.load("cal", { isExactTopic: true })), null);
});

test("serial rejects a malformed group name", () => {
    touch("chat/web.md", "---\nserial: chat group\n---\nbody\n");
    assert.throws(
        () => HandlerFile.load("chat:web", { isExactTopic: true }),
        /header field "serial" must be/,
    );
});
