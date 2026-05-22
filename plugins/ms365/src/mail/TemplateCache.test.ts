import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type MailStyleTemplate, mailStyleTemplatePath } from "./MailStyleTemplate.js";
import { TemplateCache } from "./TemplateCache.js";

let dataDir: string;

beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ms365-cache-"));
});

afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
});

function fakeTemplate(overrides: Partial<MailStyleTemplate> = {}): MailStyleTemplate {
    return {
        signature: "<div>signed</div>",
        textStyle: "font-family: Calibri; font-size: 11pt",
        usePlainText: false,
        useSignatureOnReplies: true,
        useSignatureOnForwards: false,
        ...overrides,
    };
}

async function seed(mailbox: string, template: MailStyleTemplate): Promise<string> {
    const file = mailStyleTemplatePath(dataDir, mailbox);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(template, null, 2), "utf8");
    return file;
}

test("returns null when no template file exists", async () => {
    const cache = new TemplateCache(dataDir);
    assert.equal(await cache.get("alice@example.com"), null);
});

test("returns the parsed template when the file is present", async () => {
    const tpl = fakeTemplate();
    await seed("alice@example.com", tpl);
    const cache = new TemplateCache(dataDir);
    assert.deepEqual(await cache.get("alice@example.com"), tpl);
});

test("hits the cache on unchanged mtime, re-reads on change", async () => {
    const tpl1 = fakeTemplate({ signature: "<div>v1</div>" });
    const tpl2 = fakeTemplate({ signature: "<div>v2</div>" });
    const file = await seed("alice@example.com", tpl1);
    const cache = new TemplateCache(dataDir);
    assert.deepEqual(await cache.get("alice@example.com"), tpl1);

    await writeFile(file, JSON.stringify(tpl2), "utf8");
    const now = new Date();
    await utimes(file, now, new Date(now.getTime() + 5000));
    assert.deepEqual(await cache.get("alice@example.com"), tpl2);
});

test("returns null + logs when the JSON is malformed", async () => {
    const file = mailStyleTemplatePath(dataDir, "alice@example.com");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ this is not json", "utf8");
    const logs: string[] = [];
    const cache = new TemplateCache(dataDir, (m) => logs.push(m));
    assert.equal(await cache.get("alice@example.com"), null);
    assert.ok(logs.some((l) => l.includes("could not be parsed")));
});

test("returns null + logs when a required field is missing", async () => {
    const file = mailStyleTemplatePath(dataDir, "alice@example.com");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ signature: "<p>sig</p>" }), "utf8");
    const logs: string[] = [];
    const cache = new TemplateCache(dataDir, (m) => logs.push(m));
    assert.equal(await cache.get("alice@example.com"), null);
    assert.ok(logs.some((l) => l.includes("could not be parsed")));
});

test("isolates per-mailbox entries", async () => {
    const tplAlice = fakeTemplate({ signature: "<div>alice</div>" });
    await seed("alice@example.com", tplAlice);
    const cache = new TemplateCache(dataDir);
    assert.deepEqual(await cache.get("alice@example.com"), tplAlice);
    assert.equal(await cache.get("bob@example.com"), null);
});
