import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type {
    ConfigService,
    EventRow,
    ForwardInput,
    MailProvider,
    NewMailInput,
    PluginToolCallContext,
    ReplyInput,
    ToolRunContext,
} from "@getfamiliar/shared";
import { INLINE_ATTACHMENT_LIMIT_BYTES } from "../utils/ScratchInput.js";
import { MailRegistry } from "./MailRegistry.js";
import { MailSafety } from "./MailSafety.js";
import { buildMailTools } from "./MailTools.js";

const EVENT_ID = "42";
const MAIL_ID = "fake:me@example.com:msg-1";

let scratchDir: string;

beforeEach(async () => {
    scratchDir = await mkdtemp(path.join(tmpdir(), "mail-tools-"));
    await mkdir(path.join(scratchDir, EVENT_ID));
});

afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
});

const STUB_RUN_CTX: ToolRunContext = {
    limit: 1_000_000,
    spill: async () => {
        throw new Error("spill not expected in these tests");
    },
};

/** One recorded provider call: method name plus the composition input. */
interface ProviderCall {
    readonly method: string;
    readonly input: ReplyInput | ForwardInput | NewMailInput;
}

/**
 * Provider that records every draft / send call and returns fixed ids.
 *
 * @returns The provider and its call log.
 */
function fakeProvider(): { provider: MailProvider; calls: ProviderCall[] } {
    const calls: ProviderCall[] = [];
    const provider: MailProvider = {
        pluginId: "fake",
        fetchBody: async () => "",
        fetchAttachments: async () => [],
        previewReplyRecipients: async () => ["someone@example.com"],
        draftReply: async (_m, _id, input) => {
            calls.push({ method: "draftReply", input });
            return "draft-1";
        },
        draftForward: async (_m, _id, input) => {
            calls.push({ method: "draftForward", input });
            return "draft-1";
        },
        draftNew: async (_m, input) => {
            calls.push({ method: "draftNew", input });
            return "draft-1";
        },
        sendReply: async (_m, _id, input) => {
            calls.push({ method: "sendReply", input });
        },
        sendForward: async (_m, _id, input) => {
            calls.push({ method: "sendForward", input });
        },
        sendNew: async (_m, input) => {
            calls.push({ method: "sendNew", input });
        },
        move: async () => {},
        search: async () => [],
    };
    return { provider, calls };
}

/**
 * Build the mail tools against a fake provider.
 *
 * @param allowSend - Value of `mail.allowSend`.
 * @returns A tool lookup and the provider's call log.
 */
function setup(allowSend: boolean) {
    const { provider, calls } = fakeProvider();
    const registry = new MailRegistry();
    registry.registerProvider(provider);
    const config = {
        getBool: () => allowSend,
        getArray: () => [],
    } as unknown as ConfigService;
    const tools = buildMailTools({ registry, safety: new MailSafety(config), scratchDir });
    const tool = (name: string) => {
        const found = tools.find((t) => t.name === name);
        if (!found) {
            throw new Error(`tool ${name} not built`);
        }
        return found;
    };
    return { tool, calls };
}

function callCtx(): PluginToolCallContext {
    return {
        event: { id: EVENT_ID, payload: {} } as unknown as EventRow,
        agentrun: { id: "run-1" } as unknown as PluginToolCallContext["agentrun"],
        host: {} as unknown as PluginToolCallContext["host"],
        log: {} as unknown as PluginToolCallContext["log"],
        toolRunContext: STUB_RUN_CTX,
    };
}

/**
 * Write a file into the event's scratch folder.
 *
 * @returns Its container-visible path.
 */
async function scratchFile(name: string, contents: string | Buffer): Promise<string> {
    await writeFile(path.join(scratchDir, EVENT_ID, name), contents);
    return `/scratch/${EVENT_ID}/${name}`;
}

test("mail_send_new passes scratch files as attachments and names them in the result", async () => {
    const { tool, calls } = setup(true);
    const pdf = await scratchFile("report.pdf", "%PDF-1.4");
    const result = (await tool("mail_send_new").execute(
        {
            from: "fake:me@example.com",
            to: ["someone@example.com"],
            subject: "Report",
            body: "see attached",
            attachments: [pdf],
        },
        callCtx(),
    )) as Record<string, unknown>;
    assert.deepEqual(result, { sent: true, attachments: ["report.pdf"] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "sendNew");
    const [attachment] = calls[0].input.attachments;
    assert.equal(attachment.name, "report.pdf");
    assert.equal(attachment.contentType, "application/pdf");
    assert.equal(attachment.contents.toString(), "%PDF-1.4");
});

test("mail_send_reply and mail_send_forward pass attachments through", async () => {
    const { tool, calls } = setup(true);
    const file = await scratchFile("notes.txt", "hello");
    await tool("mail_send_reply").execute(
        { mail_id: MAIL_ID, body: "ok", attachments: [file] },
        callCtx(),
    );
    await tool("mail_send_forward").execute(
        { mail_id: MAIL_ID, to: ["someone@example.com"], attachments: [file] },
        callCtx(),
    );
    assert.deepEqual(
        calls.map((c) => [c.method, c.input.attachments.map((a) => a.name)]),
        [
            ["sendReply", ["notes.txt"]],
            ["sendForward", ["notes.txt"]],
        ],
    );
});

test("without attachments the input carries an empty list and the result keeps its shape", async () => {
    const { tool, calls } = setup(true);
    const result = await tool("mail_send_reply").execute(
        { mail_id: MAIL_ID, body: "ok" },
        callCtx(),
    );
    assert.deepEqual(result, { sent: true });
    assert.deepEqual(calls[0].input.attachments, []);
});

test("the safety-gate draft fallback keeps the attachments", async () => {
    const { tool, calls } = setup(false);
    const file = await scratchFile("notes.txt", "hello");
    const result = (await tool("mail_send_reply").execute(
        { mail_id: MAIL_ID, body: "ok", attachments: [file] },
        callCtx(),
    )) as Record<string, unknown>;
    assert.equal(result.sent, false);
    assert.deepEqual(result.attachments, ["notes.txt"]);
    assert.equal(calls[0].method, "draftReply");
    assert.equal(calls[0].input.attachments.length, 1);
});

test("mail_draft_new attaches files too", async () => {
    const { tool, calls } = setup(true);
    const file = await scratchFile("notes.txt", "hello");
    const result = (await tool("mail_draft_new").execute(
        {
            from: "fake:me@example.com",
            to: ["someone@example.com"],
            subject: "s",
            body: "b",
            attachments: [file],
        },
        callCtx(),
    )) as Record<string, unknown>;
    assert.deepEqual(result.attachments, ["notes.txt"]);
    assert.equal(calls[0].input.attachments.length, 1);
});

/**
 * Assert that a send with `attachments` fails with `code` and never
 * reaches the provider.
 */
async function assertRejected(attachments: readonly string[], code: string): Promise<void> {
    const { tool, calls } = setup(true);
    await assert.rejects(
        tool("mail_send_reply").execute({ mail_id: MAIL_ID, body: "ok", attachments }, callCtx()),
        (err: unknown) => (err as { code?: string }).code === code,
    );
    assert.equal(calls.length, 0);
}

test("a path of another event's scratch folder is rejected", async () => {
    await mkdir(path.join(scratchDir, "7"));
    await writeFile(path.join(scratchDir, "7", "secret.txt"), "x");
    await assertRejected(["/scratch/7/secret.txt"], "BadScratchPath");
});

test("'..' segments are rejected", async () => {
    await writeFile(path.join(scratchDir, "outside.txt"), "x");
    await assertRejected([`/scratch/${EVENT_ID}/../outside.txt`], "BadScratchPath");
});

test("a symlink pointing outside the event folder is rejected", async () => {
    await writeFile(path.join(scratchDir, "outside.txt"), "x");
    await symlink(
        path.join(scratchDir, "outside.txt"),
        path.join(scratchDir, EVENT_ID, "link.txt"),
    );
    await assertRejected([`/scratch/${EVENT_ID}/link.txt`], "BadScratchPath");
});

test("a directory or a missing file is rejected", async () => {
    await mkdir(path.join(scratchDir, EVENT_ID, "sub"));
    await assertRejected([`/scratch/${EVENT_ID}/sub`], "BadScratchPath");
    await assertRejected([`/scratch/${EVENT_ID}/missing.txt`], "BadScratchPath");
});

test("a file over 3 MB is rejected before the provider is called", async () => {
    const big = await scratchFile("big.bin", Buffer.alloc(INLINE_ATTACHMENT_LIMIT_BYTES + 1));
    const small = await scratchFile("small.txt", "ok");
    await assertRejected([small, big], "AttachmentTooLarge");
});
