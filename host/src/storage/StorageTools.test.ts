import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
    EventRow,
    PluginTool,
    PluginToolCallContext,
    ToolRunContext,
} from "@getfamiliar/shared";
import { hasCode, makeStorageHarness } from "./StorageTestHarness.js";
import { buildStorageTools } from "./StorageTools.js";

const STUB_RUN_CTX: ToolRunContext = {
    limit: 1_000_000,
    spill: async () => {
        throw new Error("spill not expected");
    },
};

/** Minimal call context: Berlin timezone, event evt-1, run run-1. */
function fakeCallCtx(): PluginToolCallContext {
    return {
        event: { id: "evt-1" } as EventRow,
        agentrun: { id: "run-1" } as unknown as PluginToolCallContext["agentrun"],
        host: {
            config: {
                getString: () => "Europe/Berlin",
            },
        } as unknown as PluginToolCallContext["host"],
        log: {} as unknown as PluginToolCallContext["log"],
        toolRunContext: STUB_RUN_CTX,
    };
}

function find(tools: readonly PluginTool[], name: string): PluginTool {
    const t = tools.find((x) => x.name === name);
    if (!t) {
        throw new Error(`tool ${name} not built`);
    }
    return t;
}

const WRITE_TOOLS = [
    "storage_write",
    "storage_mkdir",
    "storage_move",
    "storage_copy",
    "storage_delete",
];

describe("storage tools", () => {
    it("registers all ten tools in the storage group; delete needs approval", async () => {
        const h = await makeStorageHarness({ mounts: {} });
        const tools = buildStorageTools(h.service);
        assert.equal(tools.length, 10);
        assert.ok(
            tools.every((t) => t.name.startsWith("storage_") && t.groups?.includes("storage")),
        );
        assert.equal(find(tools, "storage_delete").level, "approval");
        assert.equal(find(tools, "storage_write").level, undefined);
    });

    it("keeps write tools visible but denies them while allowWrite is false", async () => {
        const h = await makeStorageHarness({
            mounts: { m: { plugin: "fake", account: "a@x", access: "readwrite" } },
        });
        const id = h.fake.seed("a@x", null, "/Familiar/a.txt");
        const tools = buildStorageTools(h.service);
        for (const name of WRITE_TOOLS) {
            assert.ok(
                tools.some((t) => t.name === name),
                `${name} registered`,
            );
        }
        const calls: Record<string, object> = {
            storage_write: { ref: "m:/Familiar/b.txt", content: "x" },
            storage_mkdir: { ref: "m:/Familiar/d" },
            storage_move: { ref: `m#${id}`, new_name: "c.txt" },
            storage_copy: { ref: `m#${id}`, to_folder: "m:/Familiar" },
            storage_delete: { ref: `m#${id}` },
        };
        for (const [name, args] of Object.entries(calls)) {
            await assert.rejects(
                find(tools, name).execute(args, fakeCallCtx()),
                (err: Error) =>
                    hasCode("PolicyDenied")(err) && /storage\.allowWrite: false/.test(err.message),
                name,
            );
        }
        const mounts = (await find(tools, "storage_list_mounts").execute(
            {},
            fakeCallCtx(),
        )) as string;
        const [header, row] = mounts.split("\n");
        assert.equal(
            header,
            "[storage mounts · 1 mount · writing disabled (storage.allowWrite: false)]",
        );
        assert.deepEqual(JSON.parse(row ?? "{}"), {
            mount: "m",
            provider: "fake",
            access: "read",
            contentSearch: true,
        });
    });

    it("lists with a header, local timestamps and pagination", async () => {
        const h = await makeStorageHarness({ mounts: { m: { plugin: "fake", account: "a@x" } } });
        for (const n of ["b.txt", "a.txt", "c.txt"]) {
            h.fake.seed("a@x", null, `/Docs/${n}`, { content: n });
        }
        const tool = find(buildStorageTools(h.service), "storage_list");
        const out = (await tool.execute({ ref: "m:/Docs", limit: 2 }, fakeCallCtx())) as string;
        const lines = out.split("\n");
        assert.match(lines[0] ?? "", /^\[m:\/Docs · 2 items · next_cursor=\S+\]$/);
        const row = JSON.parse(lines[1] ?? "{}");
        assert.equal(row.ref, "m:/Docs/a.txt");
        assert.match(row.id, /^m#id\d+$/);
        assert.match(row.modified, /\+01:00$/);
        const cursor = /next_cursor=(\S+)\]/.exec(lines[0] ?? "")?.[1];
        const last = (await tool.execute(
            { ref: "m:/Docs", limit: 2, cursor },
            fakeCallCtx(),
        )) as string;
        assert.equal(last.split("\n")[0], "[m:/Docs · 1 item]");
    });

    it("writes with a provenance header and reports the conflict message", async () => {
        const h = await makeStorageHarness({
            allowWrite: true,
            mounts: { m: { plugin: "fake", account: "a@x", access: "readwrite" } },
        });
        const tool = find(buildStorageTools(h.service), "storage_write");
        const out = (await tool.execute(
            { ref: "m:/Familiar/Report.md", content: "hello" },
            fakeCallCtx(),
        )) as string;
        assert.match(out, /^\[written m:\/Familiar\/Report\.md · m#id\d+ · rev 1 · 5 B\]$/);
        await assert.rejects(
            tool.execute({ ref: "m:/Familiar/Report.md", content: "again" }, fakeCallCtx()),
            hasCode("NameConflict"),
        );
    });

    it("downloads with one line per ref", async () => {
        const h = await makeStorageHarness({ mounts: { m: { plugin: "fake", account: "a@x" } } });
        h.fake.seed("a@x", null, "/a.txt", { content: "abc" });
        const tool = find(buildStorageTools(h.service), "storage_download");
        const out = (await tool.execute(
            { refs: ["m:/a.txt", "m:/missing"] },
            fakeCallCtx(),
        )) as string;
        assert.deepEqual(out.split("\n"), [
            "[download 1 of 2 files · 3 B]",
            "m:/a.txt → /scratch/evt-1/storage/m/a.txt (3 B)",
            "m:/missing → error: m:/missing not found",
        ]);
    });

    it("accepts a single `ref` as well as `refs`, but not both or neither", async () => {
        const h = await makeStorageHarness({ mounts: { m: { plugin: "fake", account: "a@x" } } });
        h.fake.seed("a@x", null, "/a.txt", { content: "abc" });
        const tool = find(buildStorageTools(h.service), "storage_download");
        const out = (await tool.execute({ ref: "m:/a.txt" }, fakeCallCtx())) as string;
        assert.deepEqual(out.split("\n"), [
            "[download 1 of 1 file · 3 B]",
            "m:/a.txt → /scratch/evt-1/storage/m/a.txt (3 B)",
        ]);
        await assert.rejects(tool.execute({}, fakeCallCtx()), hasCode("BadArgs"));
        await assert.rejects(
            tool.execute({ ref: "m:/a.txt", refs: ["m:/a.txt"] }, fakeCallCtx()),
            hasCode("BadArgs"),
        );
        await assert.rejects(tool.execute({ refs: [] }, fakeCallCtx()), hasCode("BadArgs"));
    });

    it("searches with modified day filters and a header", async () => {
        const h = await makeStorageHarness({ mounts: { m: { plugin: "fake", account: "a@x" } } });
        h.fake.seed("a@x", null, "/invoice.pdf", { mimeType: "application/pdf" });
        const tool = find(buildStorageTools(h.service), "storage_search");
        const out = (await tool.execute(
            { query: "invoice", modified_from_day: "2025-12-31", modified_to_day: "2026-01-01" },
            fakeCallCtx(),
        )) as string;
        const [header, row] = out.split("\n");
        assert.equal(header, '[search "invoice" · mounts m · 1 hit]');
        assert.equal(JSON.parse(row ?? "{}").matched_in, "name");
        const none = (await tool.execute(
            { query: "invoice", modified_to_day: "2025-12-31" },
            fakeCallCtx(),
        )) as string;
        assert.equal(none, '[search "invoice" · mounts m · 0 hits]');
        await assert.rejects(
            tool.execute({ query: "x", modified_from_day: "nope" }, fakeCallCtx()),
            hasCode("BadArgs"),
        );
    });
});
