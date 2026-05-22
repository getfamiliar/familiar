import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type MailStyleTemplate, mailStyleTemplatePath } from "@getfamiliar/shared";
import { MailStyleStore } from "./MailStyleStore.js";

let dataDir: string;

beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "mail-style-store-"));
});

afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
});

function template(overrides: Partial<MailStyleTemplate> = {}): MailStyleTemplate {
    return {
        signature: "<div>signed</div>",
        textStyle: "font-family: Calibri; font-size: 11pt",
        usePlainText: false,
        useSignatureOnReplies: true,
        useSignatureOnForwards: false,
        ...overrides,
    };
}

async function seed(mailbox: string, tpl: MailStyleTemplate): Promise<string> {
    const file = mailStyleTemplatePath(dataDir, mailbox);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(tpl, null, 2), "utf8");
    return file;
}

test("get returns undefined when no template file exists", async () => {
    const store = new MailStyleStore(dataDir);
    assert.equal(await store.get("alice@example.com"), undefined);
});

test("get returns the parsed template when the file is present", async () => {
    const tpl = template();
    await seed("alice@example.com", tpl);
    const store = new MailStyleStore(dataDir);
    assert.deepEqual(await store.get("alice@example.com"), tpl);
});

test("get hits the cache on unchanged mtime, re-reads on change", async () => {
    const tpl1 = template({ signature: "<div>v1</div>" });
    const tpl2 = template({ signature: "<div>v2</div>" });
    const file = await seed("alice@example.com", tpl1);
    const store = new MailStyleStore(dataDir);
    assert.deepEqual(await store.get("alice@example.com"), tpl1);

    await writeFile(file, JSON.stringify(tpl2), "utf8");
    const now = new Date();
    await utimes(file, now, new Date(now.getTime() + 5000));
    assert.deepEqual(await store.get("alice@example.com"), tpl2);
});

test("get returns undefined + logs when the JSON is malformed", async () => {
    const file = mailStyleTemplatePath(dataDir, "alice@example.com");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ not json", "utf8");
    const logs: string[] = [];
    const store = new MailStyleStore(dataDir, (m) => logs.push(m));
    assert.equal(await store.get("alice@example.com"), undefined);
    assert.ok(logs.some((l) => l.includes("could not be parsed")));
});

test("get returns undefined + logs when a required field is missing", async () => {
    const file = mailStyleTemplatePath(dataDir, "alice@example.com");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ signature: "<p>sig</p>" }), "utf8");
    const logs: string[] = [];
    const store = new MailStyleStore(dataDir, (m) => logs.push(m));
    assert.equal(await store.get("alice@example.com"), undefined);
    assert.ok(logs.some((l) => l.includes("could not be parsed")));
});

test("update creates a new file with defaults for omitted fields", async () => {
    const store = new MailStyleStore(dataDir);
    const result = await store.update("alice@example.com", "default", {
        signature: "<div>just sig</div>",
    });
    assert.deepEqual(result, {
        signature: "<div>just sig</div>",
        textStyle: "",
        usePlainText: false,
        useSignatureOnReplies: false,
        useSignatureOnForwards: false,
    });
    const written = JSON.parse(
        await readFile(mailStyleTemplatePath(dataDir, "alice@example.com"), "utf8"),
    );
    assert.deepEqual(written, result);
});

test("update merges supplied fields into an existing file", async () => {
    await seed("alice@example.com", template());
    const store = new MailStyleStore(dataDir);
    const result = await store.update("alice@example.com", "default", {
        usePlainText: true,
        signature: "<p>new sig</p>",
    });
    assert.equal(result.signature, "<p>new sig</p>");
    assert.equal(result.usePlainText, true);
    // Preserved fields:
    assert.equal(result.textStyle, "font-family: Calibri; font-size: 11pt");
    assert.equal(result.useSignatureOnReplies, true);
    assert.equal(result.useSignatureOnForwards, false);
});

test("update supports non-default names alongside default", async () => {
    const store = new MailStyleStore(dataDir);
    await store.update("alice@example.com", "default", { signature: "<p>biz</p>" });
    await store.update("alice@example.com", "personal", { signature: "<p>fun</p>" });
    const biz = await store.get("alice@example.com", "default");
    const fun = await store.get("alice@example.com", "personal");
    assert.equal(biz?.signature, "<p>biz</p>");
    assert.equal(fun?.signature, "<p>fun</p>");
});

test("list enumerates every (mailbox, name) tuple sorted by mailbox then name", async () => {
    const store = new MailStyleStore(dataDir);
    await store.update("bob@example.com", "default", { signature: "<p>b</p>" });
    await store.update("alice@example.com", "personal", { signature: "<p>p</p>" });
    await store.update("alice@example.com", "default", { signature: "<p>d</p>" });
    const out = await store.list();
    assert.deepEqual(out, [
        { mailbox: "alice@example.com", name: "default" },
        { mailbox: "alice@example.com", name: "personal" },
        { mailbox: "bob@example.com", name: "default" },
    ]);
});

test("list returns empty when no templates exist yet", async () => {
    const store = new MailStyleStore(dataDir);
    assert.deepEqual(await store.list(), []);
});
