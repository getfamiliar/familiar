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

function example(kind: SentExample["kind"], innerHtml: string, contentType = "html"): SentExample {
    return {
        kind,
        subject: `Subject ${kind}`,
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

test("ms365_get_sent_sample stages three sample files with a shared random suffix", async () => {
    setActiveLogins(fakeLogins());
    const restore = stubSampler({
        reply: [example("reply", "<p>thanks</p>")],
        forward: [example("forward", "<p>fyi</p>")],
        new: [example("new", "<p>hello</p><div>sig</div>")],
    });
    try {
        const captured = { writes: [] as { name: string; contents: Buffer }[] };
        const t = buildSentSampleTool();
        const result = (await t.execute(
            { mailbox: "alice@example.com" },
            fakeCallCtx(captured),
        )) as {
            sampleFiles: { reply: string; forward: string; new: string };
            summary: Record<string, number>;
        };
        assert.equal(captured.writes.length, 3);
        // All three filenames share the same 6-hex-char suffix.
        const names = captured.writes.map((w) => w.name);
        const suffixes = names.map((n) => n.match(/sample\.\w+\.([0-9a-f]+)\.md/)?.[1]);
        assert.ok(suffixes.every((s) => s && s.length === 6 && /^[0-9a-f]+$/.test(s)));
        assert.equal(new Set(suffixes).size, 1, "all three files should share one suffix");
        // The returned paths line up with the writes.
        assert.ok(result.sampleFiles.reply.endsWith(names.find((n) => n.includes("reply"))!));
        assert.ok(result.sampleFiles.forward.endsWith(names.find((n) => n.includes("forward"))!));
        assert.ok(result.sampleFiles.new.endsWith(names.find((n) => n.includes("new"))!));
        // Summary is passed through verbatim.
        assert.equal(result.summary.scanned, 100);
    } finally {
        restore();
    }
});

test("ms365_get_sent_sample writes sampler summary + bodyContentType header in each file", async () => {
    setActiveLogins(fakeLogins());
    const restore = stubSampler({
        reply: [example("reply", "<p>ok</p>", "text")],
        forward: [],
        new: [example("new", "<p>fresh</p>", "html")],
    });
    try {
        const captured = { writes: [] as { name: string; contents: Buffer }[] };
        const t = buildSentSampleTool();
        await t.execute({ mailbox: "alice@example.com" }, fakeCallCtx(captured));
        const replyFile = captured.writes
            .find((w) => w.name.includes("reply"))!
            .contents.toString("utf8");
        assert.match(replyFile, /kind: reply/);
        assert.match(replyFile, /bodyContentType: text/);
        assert.match(replyFile, /Sampler summary: scanned 100/);
        const forwardFile = captured.writes
            .find((w) => w.name.includes("forward"))!
            .contents.toString("utf8");
        // Empty bucket file still carries the header + summary.
        assert.match(forwardFile, /Got 0 examples/);
        assert.match(forwardFile, /no examples/);
        const newFile = captured.writes
            .find((w) => w.name.includes("new"))!
            .contents.toString("utf8");
        assert.match(newFile, /bodyContentType: html/);
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
