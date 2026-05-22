import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { EmitHandle, EventFile, HostContext, NewEvent } from "@getfamiliar/shared";
import type { MailboxTarget } from "./MailboxMap.js";
import { type MailStyleTemplate, mailStyleTemplatePath } from "./MailStyleTemplate.js";
import { type MailKind, type SentExample, SentSampler } from "./SentSampler.js";
import { TemplateExtractor } from "./TemplateExtractor.js";

/** Signature whose anchor is `Engineering` (10 chars — longest run). */
const FAKE_SIGNATURE = `<div>Cottleston Engineering<br>Steffen Müller</div>`;
const FAKE_TEXT_STYLE = "font-family: Calibri; font-size: 11pt";

interface EmitCall {
    readonly mode: string;
    readonly prompt: string;
}

/**
 * Minimal stub of {@link HostContext} that captures events and serves
 * pre-staged results for each event mode (signature / textStyle). The
 * default canned responses are good enough for the happy-path test;
 * per-test setters override per mode.
 */
function makeCtx(dataDir: string): {
    ctx: HostContext;
    calls: EmitCall[];
    logs: string[];
    setResult(mode: "signature" | "textStyle", text: string): void;
} {
    const calls: EmitCall[] = [];
    const logs: string[] = [];
    const results: Record<string, string> = {
        signature: FAKE_SIGNATURE,
        textStyle: FAKE_TEXT_STYLE,
    };
    const ctx = {
        events: {
            async emit(event: NewEvent): Promise<EmitHandle> {
                const mode = (event.payload as { mode?: string }).mode ?? "";
                calls.push({ mode, prompt: event.prompt ?? "" });
                return {
                    id: `evt-${calls.length}`,
                    settled: Promise.resolve(results[mode] ?? ""),
                };
            },
        },
        chat: {
            async subscribe() {
                throw new Error("not used");
            },
        },
        scratch: {
            async addFiles(
                _eventId: string,
                _files: readonly EventFile[],
            ): Promise<readonly string[]> {
                return [];
            },
        },
        log: (msg: string) => {
            logs.push(msg);
        },
        dataDir,
        config: {
            getString: () => null,
            getNumber: () => null,
            getBool: () => null,
            getArray: () => [],
            getMapping: () => ({}),
        },
        mail: {
            registerProvider() {},
        },
        calendar: {
            registerProvider() {},
        },
        mcp: {
            getList: () => [],
        },
    } as unknown as HostContext;
    return {
        ctx,
        calls,
        logs,
        setResult: (mode, text) => {
            results[mode] = text;
        },
    };
}

/** Stub mailbox target — the extractor only uses `.mailbox`. */
function makeTarget(mailbox: string): MailboxTarget {
    return {
        mailbox,
        upn: mailbox,
        isShared: false,
        auth: {} as MailboxTarget["auth"],
    };
}

interface BucketSpec {
    readonly reply: readonly SentExample[];
    readonly forward: readonly SentExample[];
    readonly new: readonly SentExample[];
}

function example(
    kind: MailKind,
    innerHtml: string,
    contentType: "html" | "text" = "html",
): SentExample {
    return {
        kind,
        subject: `Sample ${kind}`,
        sentDateTime: "2026-05-21T12:00:00Z",
        innerHtml,
        contentType,
    };
}

function defaultBuckets(): BucketSpec {
    return {
        reply: [example("reply", "<p>thanks!</p>")],
        forward: [example("forward", "<p>fyi</p>")],
        new: [example("new", "<p>hello</p>")],
    };
}

function stubSampler(buckets: BucketSpec = defaultBuckets()): () => void {
    const original = SentSampler.prototype.sample;
    SentSampler.prototype.sample = async () => ({
        buckets,
        summary: {
            scanned: buckets.reply.length + buckets.forward.length + buckets.new.length,
            kept: buckets.reply.length + buckets.forward.length + buckets.new.length,
            droppedAsMeeting: 0,
            droppedAsOversize: 0,
            droppedAsBucketFull: 0,
            droppedAsEmptyAfterStrip: 0,
        },
    });
    return () => {
        SentSampler.prototype.sample = original;
    };
}

let dataDir: string;
let restoreSampler: () => void;

beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ms365-tmpl-"));
    restoreSampler = stubSampler();
});

afterEach(async () => {
    restoreSampler();
    await rm(dataDir, { recursive: true, force: true });
});

async function readTemplate(mailbox: string): Promise<MailStyleTemplate> {
    const file = mailStyleTemplatePath(dataDir, mailbox);
    return JSON.parse(await readFile(file, "utf8")) as MailStyleTemplate;
}

test("refreshAll emits two events per mailbox and writes the JSON template", async () => {
    const target = makeTarget("alice@example.com");
    const { ctx, calls } = makeCtx(dataDir);
    const extractor = new TemplateExtractor({
        ctx,
        mailboxMap: [target],
        exampleCount: 3,
    });
    await extractor.refreshAll();
    assert.equal(calls.length, 2, "one event per extraction mode");
    assert.deepEqual(calls.map((c) => c.mode).sort(), ["signature", "textStyle"]);
    const tpl = await readTemplate(target.mailbox);
    assert.equal(tpl.signature, FAKE_SIGNATURE);
    assert.equal(tpl.textStyle, FAKE_TEXT_STYLE);
});

test("useSignatureOnReplies is true when ≥ half of reply samples contain the signature anchor", async () => {
    restoreSampler();
    restoreSampler = stubSampler({
        // 2 of 3 reply samples carry the "Engineering" anchor.
        reply: [
            example("reply", "<p>thanks!</p><div>Cottleston Engineering</div>"),
            example("reply", "<p>ack</p><div>Cottleston Engineering<br>Steffen</div>"),
            example("reply", "<p>k</p>"),
        ],
        forward: [example("forward", "<p>fyi</p>")],
        new: [example("new", "<p>hello</p><div>Cottleston Engineering</div>")],
    });
    const target = makeTarget("alice@example.com");
    const { ctx } = makeCtx(dataDir);
    const extractor = new TemplateExtractor({
        ctx,
        mailboxMap: [target],
        exampleCount: 3,
    });
    await extractor.refreshAll();
    const tpl = await readTemplate(target.mailbox);
    assert.equal(tpl.useSignatureOnReplies, true);
    assert.equal(tpl.useSignatureOnForwards, false, "forward bucket has no anchor");
});

test("useSignatureOnReplies is false when the anchor isn't in the reply bucket", async () => {
    restoreSampler();
    restoreSampler = stubSampler({
        reply: [example("reply", "<p>thanks!</p>"), example("reply", "<p>ack</p>")],
        forward: [example("forward", "<p>fyi</p>")],
        new: [example("new", "<p>hello</p><div>Cottleston Engineering</div>")],
    });
    const target = makeTarget("alice@example.com");
    const { ctx } = makeCtx(dataDir);
    const extractor = new TemplateExtractor({
        ctx,
        mailboxMap: [target],
        exampleCount: 3,
    });
    await extractor.refreshAll();
    const tpl = await readTemplate(target.mailbox);
    assert.equal(tpl.useSignatureOnReplies, false);
});

test("usePlainText is true when the sample's contentType is dominantly text", async () => {
    restoreSampler();
    restoreSampler = stubSampler({
        reply: [example("reply", "<p>thanks!</p>", "text")],
        forward: [example("forward", "<p>fyi</p>", "text")],
        new: [example("new", "<p>hello</p>", "text")],
    });
    const target = makeTarget("alice@example.com");
    const { ctx } = makeCtx(dataDir);
    const extractor = new TemplateExtractor({
        ctx,
        mailboxMap: [target],
        exampleCount: 3,
    });
    await extractor.refreshAll();
    const tpl = await readTemplate(target.mailbox);
    assert.equal(tpl.usePlainText, true);
});

test("empty signature event keeps the previous file untouched", async () => {
    const target = makeTarget("alice@example.com");
    const file = mailStyleTemplatePath(dataDir, target.mailbox);
    const previous: MailStyleTemplate = {
        signature: "<p>previous sig</p>",
        textStyle: "font-family: Times",
        usePlainText: false,
        useSignatureOnReplies: true,
        useSignatureOnForwards: true,
    };
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(previous), "utf8");

    const { ctx, calls, setResult } = makeCtx(dataDir);
    // Stage empty signature result; textStyle won't run because the
    // extractor returns early on the null signature.
    setResult("signature", "");
    const extractor = new TemplateExtractor({
        ctx,
        mailboxMap: [target],
        exampleCount: 3,
    });
    await extractor.refreshAll();
    assert.equal(calls.length, 1, "second event should be skipped after empty signature");
    assert.equal(calls[0].mode, "signature");
    const stillThere = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(stillThere, previous, "previous JSON template preserved");
});

test("refreshMissingTemplates only runs for mailboxes whose file is missing", async () => {
    const present = makeTarget("alice@example.com");
    const absent = makeTarget("bob@example.com");
    // Pre-seed alice's template.
    const aliceFile = mailStyleTemplatePath(dataDir, present.mailbox);
    await mkdir(path.dirname(aliceFile), { recursive: true });
    await writeFile(
        aliceFile,
        JSON.stringify({
            signature: "<p>existing</p>",
            textStyle: "font-family: x",
            usePlainText: false,
            useSignatureOnReplies: false,
            useSignatureOnForwards: false,
        }),
        "utf8",
    );

    const { ctx, calls } = makeCtx(dataDir);
    const extractor = new TemplateExtractor({
        ctx,
        mailboxMap: [present, absent],
        exampleCount: 3,
    });
    await extractor.refreshMissingTemplates();
    // Only bob ran ⇒ 2 events (signature + textStyle).
    assert.equal(calls.length, 2);
    assert.ok(existsSync(mailStyleTemplatePath(dataDir, absent.mailbox)));
});

test("strips a leading ```html fence around the signature output", async () => {
    const target = makeTarget("alice@example.com");
    const { ctx, setResult } = makeCtx(dataDir);
    setResult("signature", `\`\`\`html\n${FAKE_SIGNATURE}\n\`\`\``);
    const extractor = new TemplateExtractor({
        ctx,
        mailboxMap: [target],
        exampleCount: 3,
    });
    await extractor.refreshAll();
    const tpl = await readTemplate(target.mailbox);
    assert.equal(tpl.signature, FAKE_SIGNATURE);
});

test("strips a leading ```css fence around the textStyle output", async () => {
    const target = makeTarget("alice@example.com");
    const { ctx, setResult } = makeCtx(dataDir);
    setResult("textStyle", `\`\`\`css\n${FAKE_TEXT_STYLE}\n\`\`\``);
    const extractor = new TemplateExtractor({
        ctx,
        mailboxMap: [target],
        exampleCount: 3,
    });
    await extractor.refreshAll();
    const tpl = await readTemplate(target.mailbox);
    assert.equal(tpl.textStyle, FAKE_TEXT_STYLE);
});

test("skips extraction entirely when every bucket is empty", async () => {
    restoreSampler();
    restoreSampler = stubSampler({ reply: [], forward: [], new: [] });
    const target = makeTarget("alice@example.com");
    const { ctx, calls, logs } = makeCtx(dataDir);
    const extractor = new TemplateExtractor({
        ctx,
        mailboxMap: [target],
        exampleCount: 3,
    });
    await extractor.refreshAll();
    assert.equal(calls.length, 0, "no events emitted for an empty sample");
    assert.ok(!existsSync(mailStyleTemplatePath(dataDir, target.mailbox)));
    assert.ok(logs.some((l) => l.includes("no usable examples")));
});
