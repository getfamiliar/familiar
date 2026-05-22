import assert from "node:assert/strict";
import { test } from "node:test";
import type {
    EventRow,
    HostContext,
    PluginToolCallContext,
    ToolRunContext,
} from "@getfamiliar/shared";
import { setActiveLogins } from "../auth/ActiveLogins.js";
import type { LoginStore } from "../auth/LoginStore.js";
import { type SampleResult, type SentExample, SentSampler } from "./SentSampler.js";
import { buildSentSampleTool } from "./SentSampleTool.js";

const STUB_RUN_CTX: ToolRunContext = {
    limit: 5_000_000,
    spill: async () => {
        throw new Error("spill not expected");
    },
};

function fakeAuth(): unknown {
    return {
        getAccessTokenSilent: async () => "fake-token",
    };
}

function fakeLogins(): LoginStore {
    return {
        byUpn: (_upn: string) => fakeAuth(),
        // Other methods aren't used by the tool.
    } as unknown as LoginStore;
}

function example(
    kind: SentExample["kind"],
    innerHtml: string,
    contentType = "html",
    subject = `Subject ${kind}`,
): SentExample {
    return {
        kind,
        subject,
        sentDateTime: "2026-05-21T12:00:00Z",
        innerHtml,
        contentType,
    };
}

function stubSampler(buckets: Record<SentExample["kind"], readonly SentExample[]>): () => void {
    const original = SentSampler.prototype.sample;
    SentSampler.prototype.sample = async (): Promise<SampleResult> => ({
        buckets,
        summary: {
            scanned: 100,
            kept: buckets.reply.length + buckets.forward.length + buckets.new.length,
            droppedAsMeeting: 50,
            droppedAsOversize: 5,
            droppedAsBucketFull: 30,
            droppedAsEmptyAfterStrip: 5,
        },
    });
    return () => {
        SentSampler.prototype.sample = original;
    };
}

function fakeCallCtx(captured: {
    writes: { name: string; contents: Buffer }[];
}): PluginToolCallContext {
    const host: Partial<HostContext> = {
        scratch: {
            addFiles: async (
                eventId: string,
                files: readonly { name: string; contents?: Buffer; sourcePath?: string }[],
            ) => {
                for (const f of files) {
                    if (f.contents) {
                        captured.writes.push({ name: f.name, contents: f.contents });
                    }
                }
                return files.map((f) => `/scratch/${eventId}/${f.name}`);
            },
        } as unknown as HostContext["scratch"],
    };
    return {
        event: { id: "evt-1" } as EventRow,
        agentrun: { id: "run-1" } as unknown as PluginToolCallContext["agentrun"],
        host: host as HostContext,
        log: {} as unknown as PluginToolCallContext["log"],
        toolRunContext: STUB_RUN_CTX,
    };
}

test("ms365_get_sent_sample stages one .html file per example with shared hex suffix", async () => {
    setActiveLogins(fakeLogins());
    const restore = stubSampler({
        reply: [example("reply", "<p>thanks</p>")],
        forward: [example("forward", "<p>fyi</p>")],
        new: [example("new", "<p>hello one</p>"), example("new", "<p>hello two</p>")],
    });
    try {
        const captured = { writes: [] as { name: string; contents: Buffer }[] };
        const t = buildSentSampleTool();
        await t.execute({ mailbox: "alice@example.com" }, fakeCallCtx(captured));
        assert.equal(captured.writes.length, 4);
        const namePattern = /^sample\.(reply|forward|new)\.\d+\.[0-9a-f]{6}\.html$/;
        for (const w of captured.writes) {
            assert.match(w.name, namePattern, `bad filename: ${w.name}`);
        }
        const suffixes = captured.writes.map(
            (w) => w.name.match(/sample\.\w+\.\d+\.([0-9a-f]{6})\.html$/)?.[1],
        );
        assert.equal(new Set(suffixes).size, 1, "all files should share one suffix");
        // 1-based index within kind, plus innerHtml verbatim as file body.
        const newFiles = captured.writes
            .filter((w) => w.name.startsWith("sample.new."))
            .sort((a, b) => a.name.localeCompare(b.name));
        assert.equal(newFiles.length, 2);
        assert.ok(newFiles[0].name.startsWith("sample.new.1."));
        assert.ok(newFiles[1].name.startsWith("sample.new.2."));
        assert.equal(newFiles[0].contents.toString("utf8"), "<p>hello one</p>");
        assert.equal(newFiles[1].contents.toString("utf8"), "<p>hello two</p>");
        const replyFile = captured.writes.find((w) => w.name.startsWith("sample.reply.1."));
        assert.ok(replyFile, "expected a reply file");
        assert.equal(replyFile.contents.toString("utf8"), "<p>thanks</p>");
    } finally {
        restore();
    }
});

test("ms365_get_sent_sample returns summary + markdown table with the expected columns", async () => {
    setActiveLogins(fakeLogins());
    const restore = stubSampler({
        reply: [example("reply", "<p>ok</p>", "text", "Re: Foo")],
        forward: [],
        new: [example("new", "<p>fresh</p>", "html", "Hello there")],
    });
    try {
        const captured = { writes: [] as { name: string; contents: Buffer }[] };
        const t = buildSentSampleTool();
        const result = (await t.execute(
            { mailbox: "alice@example.com" },
            fakeCallCtx(captured),
        )) as string;
        assert.equal(typeof result, "string");
        assert.match(
            result,
            /Scanned 100, kept 2\. Dropped: meeting 50, oversize 5, bucket-full 30, empty-after-strip 5\./,
        );
        assert.match(result, /\| filepath \| subject \| bodyContentType \| sent \|/);
        assert.match(result, /\|---\|---\|---\|---\|/);
        // Reply row: text bodyContentType, subject from example.
        assert.match(
            result,
            /\| \/scratch\/evt-1\/sample\.reply\.1\.[0-9a-f]{6}\.html \| Re: Foo \| text \| 2026-05-21T12:00:00Z \|/,
        );
        // New row: html bodyContentType.
        assert.match(
            result,
            /\| \/scratch\/evt-1\/sample\.new\.1\.[0-9a-f]{6}\.html \| Hello there \| html \| 2026-05-21T12:00:00Z \|/,
        );
        // No forward row.
        assert.doesNotMatch(result, /sample\.forward\./);
    } finally {
        restore();
    }
});

test("ms365_get_sent_sample stages nothing and renders no-examples when all buckets empty", async () => {
    setActiveLogins(fakeLogins());
    const restore = stubSampler({ reply: [], forward: [], new: [] });
    try {
        const captured = { writes: [] as { name: string; contents: Buffer }[] };
        const t = buildSentSampleTool();
        const result = (await t.execute(
            { mailbox: "alice@example.com" },
            fakeCallCtx(captured),
        )) as string;
        assert.equal(captured.writes.length, 0);
        assert.match(result, /Scanned 100, kept 0\./);
        assert.match(result, /_\(no examples\)_/);
        assert.doesNotMatch(result, /\| filepath \|/);
    } finally {
        restore();
    }
});

test("ms365_get_sent_sample rejects an unknown mailbox with a clear error", async () => {
    setActiveLogins({
        byUpn: () => null,
    } as unknown as LoginStore);
    const t = buildSentSampleTool();
    const captured = { writes: [] as { name: string; contents: Buffer }[] };
    await assert.rejects(
        () => t.execute({ mailbox: "ghost@example.com" }, fakeCallCtx(captured)),
        /no active ms365 login/,
    );
});
