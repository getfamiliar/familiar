import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { HandlerCatalog } from "./HandlerCatalog.js";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "handler-catalog-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function touch(rel: string, contents = ""): Promise<void> {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, contents);
}

test("list emits handler paths grouped by topic", async () => {
    await touch("chat/index.md");
    await touch("chat/analyze.md");
    await touch("chat/telegram/index.md");
    await touch("grocery/fruits/order.md");

    const list = await new HandlerCatalog(root).list();
    const slashes = list.map((h) => h.slashPath);
    assert.deepEqual(slashes, [
        "/chat/analyze",
        "/chat/index",
        "/chat/telegram/index",
        "/grocery/fruits/order",
    ]);
    const tg = list.find((h) => h.slashPath === "/chat/telegram/index");
    assert.equal(tg?.topic, "chat:telegram");
    assert.equal(tg?.handler, "index");
    assert.equal(tg?.relativePath, "chat/telegram/index.md");
});

test("list skips workspace-root reserved files and the skills subtree", async () => {
    await touch("SOUL.md");
    await touch("CONTEXT.md");
    await touch("stray.md");
    await touch("skills/jira/SKILL.md");
    await touch("skills/jira/example.md");
    await touch("mail/index.md");

    const list = await new HandlerCatalog(root).list();
    assert.deepEqual(
        list.map((h) => h.slashPath),
        ["/mail/index"],
    );
});

test("list returns empty when workspace dir is missing", async () => {
    const list = await new HandlerCatalog(path.join(root, "missing")).list();
    assert.deepEqual(list, []);
});

test("resolve returns deepest existing candidate", async () => {
    await touch("chat/index.md");
    await touch("chat/telegram/index.md");
    const catalog = new HandlerCatalog(root);

    const deep = await catalog.resolve("chat:telegram", "index");
    assert.equal(deep, path.join(root, "chat/telegram/index.md"));
});

test("resolve falls back up the topic chain", async () => {
    await touch("chat/analyze.md");
    const catalog = new HandlerCatalog(root);

    const hit = await catalog.resolve("chat:telegram:group", "analyze");
    assert.equal(hit, path.join(root, "chat/analyze.md"));
});

test("resolve returns null when nothing matches", async () => {
    await touch("chat/index.md");
    const catalog = new HandlerCatalog(root);

    const miss = await catalog.resolve("chat", "missing");
    assert.equal(miss, null);
});

test("list excludes files under writable paths", async () => {
    await touch("mail/index.md");
    await touch("wiki/index.md");
    await touch("wiki/notes/recipe.md");

    const catalog = new HandlerCatalog(root, ["wiki/**"]);
    assert.deepEqual(
        (await catalog.list()).map((h) => h.slashPath),
        ["/mail/index"],
    );
});

test("resolve refuses a handler under a writable path even when it exists", async () => {
    await touch("wiki/index.md");
    const catalog = new HandlerCatalog(root, ["wiki/**"]);

    assert.equal(await catalog.resolve("wiki", "index"), null);
});

test("writable globs do not affect non-writable handlers", async () => {
    await touch("mail/index.md");
    const catalog = new HandlerCatalog(root, ["wiki/**"]);

    assert.equal(await catalog.resolve("mail", "index"), path.join(root, "mail/index.md"));
});
