import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
    type AgentRunRow,
    BANNER_MAX_ACTIVE,
    BANNER_MAX_TEXT_CHARS,
    type BannerRow,
    type NewBanner,
    ToolError,
    type ToolRunContext,
} from "@getfamiliar/shared";
import {
    type BannerStore,
    buildBannerCreateTool,
    buildBannerListTool,
    buildBannerRemoveTool,
} from "./banners.js";

const TOOL_CTX: ToolRunContext = {
    limit: 10000,
    spill: () => {
        throw new Error("unexpected spill in test");
    },
};

const TIMEZONE = "Europe/Berlin";

/** Fixed clock: 2026-11-07 10:00 in Berlin (UTC+1). */
const NOW = new Date("2026-11-07T09:00:00Z");

/** In-memory {@link BannerStore}. */
class FakeBannerStore implements BannerStore {
    readonly rows: BannerRow[] = [];
    private nextId = 1;

    async create(banner: NewBanner): Promise<BannerRow> {
        const row: BannerRow = {
            id: String(this.nextId++),
            text: banner.text,
            expiresAt: banner.expiresAt,
            createdAt: NOW.toISOString(),
            createdByAgentrunId: banner.createdByAgentrunId ?? null,
            createdByTopic: banner.createdByTopic ?? null,
        };
        this.rows.push(row);
        return row;
    }

    async remove(ids: readonly string[]): Promise<string[]> {
        const removed = this.rows.filter((row) => ids.includes(row.id)).map((row) => row.id);
        for (const id of removed) {
            this.rows.splice(
                this.rows.findIndex((row) => row.id === id),
                1,
            );
        }
        return removed;
    }

    async listActive(): Promise<BannerRow[]> {
        return [...this.rows];
    }
}

interface ToolExecutor {
    execute: (
        input: Record<string, unknown>,
        opts: { toolCallId: string; messages: unknown[] },
    ) => Promise<unknown>;
}

const PARENT = { id: "77", topic: "chat:web", privileged: true } as unknown as AgentRunRow;

/** Run `banner_create` against `store`. */
function create(store: FakeBannerStore, input: Record<string, unknown>): Promise<unknown> {
    const t = buildBannerCreateTool(
        store,
        PARENT,
        TIMEZONE,
        TOOL_CTX,
        () => NOW,
    ) as unknown as ToolExecutor;
    return t.execute(input, { toolCallId: "tc1", messages: [] });
}

/** Run `banner_remove` against `store`. */
function remove(store: FakeBannerStore, ids: number[]): Promise<unknown> {
    const t = buildBannerRemoveTool(store, TOOL_CTX) as unknown as ToolExecutor;
    return t.execute({ ids }, { toolCallId: "tc1", messages: [] });
}

/** Assert that `promise` rejects with a ToolError of `code`. */
async function assertToolError(promise: Promise<unknown>, code: string): Promise<void> {
    await assert.rejects(promise, (err: unknown) => {
        assert.ok(err instanceof ToolError);
        assert.equal(err.code, code);
        return true;
    });
}

describe("banner_create", () => {
    it("stores the banner with UTC expiry and creator lineage", async () => {
        const store = new FakeBannerStore();
        const out = (await create(store, {
            text: "  User is setting up a new phone today.  ",
            expires_at: "2026-11-07T23:59:00",
        })) as { id: number; expires_at: string };

        assert.equal(out.id, 1);
        assert.equal(out.expires_at, "2026-11-07T23:59:00+01:00");
        assert.equal(store.rows[0]?.text, "User is setting up a new phone today.");
        assert.equal(store.rows[0]?.expiresAt, "2026-11-07T22:59:00Z");
        assert.equal(store.rows[0]?.createdByAgentrunId, "77");
        assert.equal(store.rows[0]?.createdByTopic, "chat:web");
    });

    it("rejects an empty or too long text", async () => {
        const store = new FakeBannerStore();
        await assertToolError(
            create(store, { text: "  ", expires_at: "2026-11-08T00:00:00" }),
            "BadText",
        );
        await assertToolError(
            create(store, {
                text: "x".repeat(BANNER_MAX_TEXT_CHARS + 1),
                expires_at: "2026-11-08T00:00:00",
            }),
            "BadText",
        );
    });

    it("rejects an expiry in the past, unparsable or beyond the lifetime cap", async () => {
        const store = new FakeBannerStore();
        await assertToolError(
            create(store, { text: "a", expires_at: "2026-11-07T09:00:00" }),
            "BadExpiresAt",
        );
        await assertToolError(create(store, { text: "a", expires_at: "tomorrow" }), "BadExpiresAt");
        await assertToolError(
            create(store, { text: "a", expires_at: "2026-12-31T00:00:00" }),
            "BadExpiresAt",
        );
        assert.equal(store.rows.length, 0);
    });

    it("refuses beyond the active-banner limit", async () => {
        const store = new FakeBannerStore();
        for (let i = 0; i < BANNER_MAX_ACTIVE; i++) {
            await create(store, { text: `note ${i}`, expires_at: "2026-11-08T00:00:00" });
        }
        await assertToolError(
            create(store, { text: "one too many", expires_at: "2026-11-08T00:00:00" }),
            "TooManyBanners",
        );
    });
});

describe("banner_remove", () => {
    it("removes existing ids and reports unknown ones", async () => {
        const store = new FakeBannerStore();
        await create(store, { text: "a", expires_at: "2026-11-08T00:00:00" });
        const out = await remove(store, [1, 9]);
        assert.deepEqual(out, { removed: [1], notFound: [9] });
        assert.equal(store.rows.length, 0);
    });

    it("throws when no id exists", async () => {
        await assertToolError(remove(new FakeBannerStore(), [5]), "BannerNotFound");
    });
});

describe("banner_list", () => {
    it("renders active banners as JSONL in the local timezone", async () => {
        const store = new FakeBannerStore();
        await create(store, { text: "ill today", expires_at: "2026-11-07T23:59:00" });
        const t = buildBannerListTool(store, TIMEZONE, TOOL_CTX) as unknown as ToolExecutor;
        const out = (await t.execute({}, { toolCallId: "tc1", messages: [] })) as string;
        const line = JSON.parse(out.trim()) as Record<string, unknown>;
        assert.equal(line.id, 1);
        assert.equal(line.text, "ill today");
        assert.equal(line.expires_at, "2026-11-07T23:59:00+01:00");
        assert.equal(line.created_at, "2026-11-07T10:00:00+01:00");
        assert.equal(line.created_by_topic, "chat:web");
    });
});
