import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type {
    AgentRunRow,
    NewScheduledHandler,
    ScheduledHandlerRow,
    ToolRunContext,
} from "@getfamiliar/shared";
import { MockAgentRunBus, MockBusStore } from "@getfamiliar/shared/testing";
import { HandlerFile } from "../HandlerFile.js";
import { buildScheduleHandlerTool } from "./scheduleHandler.js";

const TOOL_CTX: ToolRunContext = {
    limit: 10000,
    spill: () => {
        throw new Error("unexpected spill in test");
    },
};

const TIMEZONE = "Europe/Berlin";

/**
 * Minimal stand-in for {@link import("@getfamiliar/shared").ScheduledHandlerBus}
 * supporting only `upsert` — that's all the unified tool calls in this
 * dispatch direction. Records every insert in `rows` keyed by `key`.
 */
class FakeScheduledHandlerBus {
    readonly rows = new Map<string, NewScheduledHandler>();

    async upsert(row: NewScheduledHandler): Promise<ScheduledHandlerRow> {
        this.rows.set(row.key, row);
        return {
            key: row.key,
            fireAt: row.fireAt,
            topic: row.topic,
            handler: row.handler,
            prompt: row.prompt ?? null,
            payload: row.payload ?? {},
            priority: row.priority ?? 50,
            privileged: row.privileged ?? false,
            createdAt: new Date(),
        };
    }
}

/** Per-test workspace with a single handler file the tool's HandlerFile.load can resolve. */
function setupWorkspaceWithHandler(topic: string, handler: string): string {
    const root = mkdtempSync(path.join(tmpdir(), "schedule-handler-test-"));
    const topicDir = path.join(root, ...topic.split(":"));
    mkdirSync(topicDir, { recursive: true });
    writeFileSync(path.join(topicDir, `${handler}.md`), "# stub handler\n");
    HandlerFile.setWorkspaceRoot(root);
    return root;
}

/** A parent agentrun row with sensible defaults; tests can spread overrides. */
function buildParent(eventId: string, partial: Partial<AgentRunRow> = {}): AgentRunRow {
    return {
        id: "100",
        eventId,
        parentAgentrunId: null,
        topic: "demo",
        handler: "index",
        priority: 50,
        state: "running",
        prompt: null,
        payload: {},
        result: null,
        resultText: null,
        error: null,
        privileged: false,
        calltype: null,
        retryCount: 0,
        notBefore: null,
        model: null,
        systemPrompt: null,
        initialMessages: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...partial,
    };
}

interface ToolExecutor {
    execute: (
        input: Record<string, unknown>,
        opts: { toolCallId: string; messages: unknown[] },
    ) => Promise<unknown>;
}

async function callTool(
    agentruns: MockAgentRunBus,
    scheduled: FakeScheduledHandlerBus,
    parent: AgentRunRow,
    input: Record<string, unknown>,
): Promise<unknown> {
    const t = buildScheduleHandlerTool(
        agentruns as unknown as Parameters<typeof buildScheduleHandlerTool>[0],
        scheduled as unknown as Parameters<typeof buildScheduleHandlerTool>[1],
        parent,
        TIMEZONE,
        TOOL_CTX,
    ) as unknown as ToolExecutor;
    return t.execute(input, { toolCallId: "tc1", messages: [] });
}

/** Render a wall-clock ISO string in TIMEZONE that is `offsetMinutes` from now. */
function futureLocalIso(offsetMinutes: number): string {
    const target = new Date(Date.now() + offsetMinutes * 60_000);
    const fmt = new Intl.DateTimeFormat("sv-SE", {
        timeZone: TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
    return fmt.format(target).replace(" ", "T");
}

describe("schedule_handler — immediate mode (no `when`)", () => {
    it("inserts a child agentruns row with calltype='queued' and returns { agentrunId }", async () => {
        setupWorkspaceWithHandler("demo", "followup");
        const store = new MockBusStore();
        const agentruns = new MockAgentRunBus(store);
        const scheduled = new FakeScheduledHandlerBus();
        const parent = buildParent("42");

        const out = (await callTool(agentruns, scheduled, parent, {
            handler: "followup",
        })) as { agentrunId: string };

        assert.ok(out.agentrunId);
        const child = store.agentruns.get(out.agentrunId);
        assert.ok(child);
        assert.equal(child.calltype, "queued");
        assert.equal(child.parentAgentrunId, parent.id);
        assert.equal(child.eventId, parent.eventId);
        assert.equal(scheduled.rows.size, 0);
    });

    it("slash-shaped handler with no topic resolves to derived topic + basename", async () => {
        setupWorkspaceWithHandler("mail", "send-digest");
        const store = new MockBusStore();
        const agentruns = new MockAgentRunBus(store);
        const scheduled = new FakeScheduledHandlerBus();
        // Parent's topic is "demo"; the slash-shaped handler should
        // override it via the derived topic from leading segments.
        const parent = buildParent("42");

        const out = (await callTool(agentruns, scheduled, parent, {
            handler: "mail/send-digest.md",
        })) as { agentrunId: string };

        const child = store.agentruns.get(out.agentrunId);
        assert.ok(child);
        assert.equal(child.topic, "mail");
        assert.equal(child.handler, "send-digest");
        assert.equal(child.calltype, "queued");
    });
});

describe("schedule_handler — scheduled mode (future `when`)", () => {
    it("inserts a scheduled_handlers row and returns { key, when }", async () => {
        setupWorkspaceWithHandler("demo", "followup");
        const store = new MockBusStore();
        const agentruns = new MockAgentRunBus(store);
        const scheduled = new FakeScheduledHandlerBus();
        const parent = buildParent("42");

        const when = futureLocalIso(60);
        const out = (await callTool(agentruns, scheduled, parent, {
            handler: "followup",
            when,
            key: "my-key",
        })) as { key: string; when: string };

        assert.equal(out.key, "my-key");
        assert.ok(scheduled.rows.has("my-key"));
        assert.equal(store.agentruns.size, 0);
    });

    it("auto-generates a UUID-shaped key when `key` is omitted", async () => {
        setupWorkspaceWithHandler("demo", "followup");
        const store = new MockBusStore();
        const agentruns = new MockAgentRunBus(store);
        const scheduled = new FakeScheduledHandlerBus();
        const parent = buildParent("42");

        const out = (await callTool(agentruns, scheduled, parent, {
            handler: "followup",
            when: futureLocalIso(60),
        })) as { key: string; when: string };

        assert.ok(out.key);
        // randomUUID() output: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
        assert.match(out.key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.ok(scheduled.rows.has(out.key));
    });
});

describe("schedule_handler — key without when", () => {
    it("throws BadKey", async () => {
        setupWorkspaceWithHandler("demo", "followup");
        const store = new MockBusStore();
        const agentruns = new MockAgentRunBus(store);
        const scheduled = new FakeScheduledHandlerBus();
        const parent = buildParent("42");

        await assert.rejects(
            () =>
                callTool(agentruns, scheduled, parent, {
                    handler: "followup",
                    key: "lonely-key",
                }),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { code?: string }).code, "BadKey");
                assert.match(err.message, /key.*meaningful.*when/i);
                return true;
            },
        );
        assert.equal(store.agentruns.size, 0);
        assert.equal(scheduled.rows.size, 0);
    });
});

describe("schedule_handler — past `when` silently demotes to immediate", () => {
    it("inserts an agentruns row, scheduled_handlers untouched", async () => {
        setupWorkspaceWithHandler("demo", "followup");
        const store = new MockBusStore();
        const agentruns = new MockAgentRunBus(store);
        const scheduled = new FakeScheduledHandlerBus();
        const parent = buildParent("42");

        const pastWhen = "2000-01-01T12:00:00";
        const out = (await callTool(agentruns, scheduled, parent, {
            handler: "followup",
            when: pastWhen,
        })) as { agentrunId: string };

        assert.ok(out.agentrunId);
        const child = store.agentruns.get(out.agentrunId);
        assert.equal(child?.calltype, "queued");
        assert.equal(scheduled.rows.size, 0);
    });

    it("past `when` + `key` also demotes silently (key is dropped)", async () => {
        setupWorkspaceWithHandler("demo", "followup");
        const store = new MockBusStore();
        const agentruns = new MockAgentRunBus(store);
        const scheduled = new FakeScheduledHandlerBus();
        const parent = buildParent("42");

        const out = (await callTool(agentruns, scheduled, parent, {
            handler: "followup",
            when: "2000-01-01T12:00:00",
            key: "doesntmatter",
        })) as { agentrunId: string };

        assert.ok(out.agentrunId);
        assert.equal(scheduled.rows.size, 0);
        assert.equal(scheduled.rows.has("doesntmatter"), false);
    });
});
