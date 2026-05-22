import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
    type EventRow,
    mailStyleTemplatePath,
    type PluginToolCallContext,
    type ToolRunContext,
} from "@getfamiliar/shared";
import { MailStyleStore } from "./MailStyleStore.js";
import { buildMailStyleTools } from "./MailStyleTools.js";

let dataDir: string;

beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "mail-style-tools-"));
});

afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
});

const STUB_RUN_CTX: ToolRunContext = {
    limit: 1_000_000,
    spill: async () => {
        throw new Error("spill not expected in these tests");
    },
};

function fakeCallCtx(): PluginToolCallContext {
    return {
        event: { id: "evt-1" } as EventRow,
        agentrun: { id: "run-1" } as unknown as PluginToolCallContext["agentrun"],
        host: {} as unknown as PluginToolCallContext["host"],
        log: {} as unknown as PluginToolCallContext["log"],
        toolRunContext: STUB_RUN_CTX,
    };
}

function tool(name: string) {
    const store = new MailStyleStore(dataDir);
    const t = buildMailStyleTools({ store }).find((t) => t.name === name);
    if (!t) {
        throw new Error(`tool ${name} not built`);
    }
    return { tool: t, store };
}

test("mailstyle_update creates a file with defaults filled in", async () => {
    const { tool: t } = tool("mailstyle_update");
    const result = (await t.execute(
        { mailbox: "alice@example.com", signature: "<p>sig</p>" },
        fakeCallCtx(),
    )) as Record<string, unknown>;
    assert.equal(result.signature, "<p>sig</p>");
    assert.equal(result.textStyle, "");
    assert.equal(result.usePlainText, false);
    assert.equal(result.useSignatureOnReplies, false);
    assert.equal(result.useSignatureOnForwards, false);
    const onDisk = JSON.parse(
        await readFile(mailStyleTemplatePath(dataDir, "alice@example.com"), "utf8"),
    );
    assert.deepEqual(onDisk, result);
});

test("mailstyle_update merges into an existing file", async () => {
    const { tool: t } = tool("mailstyle_update");
    await t.execute(
        {
            mailbox: "alice@example.com",
            signature: "<p>old</p>",
            textStyle: "font-family: Times",
            useSignatureOnReplies: true,
        },
        fakeCallCtx(),
    );
    const merged = (await t.execute(
        { mailbox: "alice@example.com", signature: "<p>new</p>" },
        fakeCallCtx(),
    )) as Record<string, unknown>;
    assert.equal(merged.signature, "<p>new</p>");
    assert.equal(merged.textStyle, "font-family: Times");
    assert.equal(merged.useSignatureOnReplies, true);
});

test("mailstyle_update rejects path-traversal in name", async () => {
    const { tool: t } = tool("mailstyle_update");
    await assert.rejects(
        () =>
            t.execute(
                { mailbox: "alice@example.com", name: "../escape", signature: "x" },
                fakeCallCtx(),
            ),
        /path separators/,
    );
});

test("mailstyle_update rejects missing mailbox", async () => {
    const { tool: t } = tool("mailstyle_update");
    await assert.rejects(() => t.execute({}, fakeCallCtx()), /mailbox.*required/i);
});

test("mailstyle_get returns null when no template exists", async () => {
    const { tool: t } = tool("mailstyle_get");
    const result = await t.execute({ mailbox: "ghost@example.com" }, fakeCallCtx());
    assert.equal(result, null);
});

test("mailstyle_get returns the parsed template", async () => {
    const { tool: u } = tool("mailstyle_update");
    await u.execute(
        { mailbox: "alice@example.com", signature: "<p>s</p>", textStyle: "font: 11pt" },
        fakeCallCtx(),
    );
    const { tool: g } = tool("mailstyle_get");
    const result = (await g.execute({ mailbox: "alice@example.com" }, fakeCallCtx())) as Record<
        string,
        unknown
    >;
    assert.equal(result.signature, "<p>s</p>");
    assert.equal(result.textStyle, "font: 11pt");
});

test("mailstyle_list enumerates {mailbox, name} tuples", async () => {
    const { tool: u } = tool("mailstyle_update");
    await u.execute({ mailbox: "alice@example.com", signature: "<p>a</p>" }, fakeCallCtx());
    await u.execute(
        {
            mailbox: "alice@example.com",
            name: "personal",
            signature: "<p>a-p</p>",
        },
        fakeCallCtx(),
    );
    await u.execute({ mailbox: "bob@example.com", signature: "<p>b</p>" }, fakeCallCtx());
    const { tool: l } = tool("mailstyle_list");
    const result = (await l.execute({}, fakeCallCtx())) as { templates: unknown[] };
    assert.deepEqual(result.templates, [
        { mailbox: "alice@example.com", name: "default" },
        { mailbox: "alice@example.com", name: "personal" },
        { mailbox: "bob@example.com", name: "default" },
    ]);
});
