import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type {
    AgentRunRow,
    ChatHandler,
    ChatHistoryQuery,
    ChatMessage,
    EmitOptions,
    NewEvent,
    StepResultRow,
} from "@getfamiliar/shared";
import { MockLogger } from "@getfamiliar/shared/testing";
import { buildChatController } from "./ChatController.js";
import { ChatHub, ChatInputError } from "./ChatHub.js";
import type { ChatServerEvent } from "./ChatProtocol.js";

/** A pending `settled` the test resolves or rejects. */
interface Deferred {
    resolve(text: string): void;
    reject(err: unknown): void;
}

/** Fake host services recording what the hub does. */
function fakeHost(history: ChatMessage[] = []) {
    const emitted: { event: NewEvent; options: EmitOptions | undefined; settle: Deferred }[] = [];
    const appended: { eventId: string; text: string }[] = [];
    const queries: ChatHistoryQuery[] = [];
    let handler: ChatHandler | null = null;
    let nextEventId = 100;
    const deps = {
        chat: {
            subscribe: async (_filter: unknown, h: ChatHandler) => {
                handler = h;
                return async () => {
                    handler = null;
                };
            },
            appendAssistantMessage: async (eventId: string, text: string) => {
                appended.push({ eventId, text });
            },
            listMessages: async (query: ChatHistoryQuery) => {
                queries.push(query);
                return history.slice(-query.limit);
            },
        },
        events: {
            emit: async (event: NewEvent, options?: EmitOptions) => {
                let settle: Deferred = { resolve: () => {}, reject: () => {} };
                const settled = new Promise<string>((resolve, reject) => {
                    settle = { resolve, reject };
                });
                settled.catch(() => {});
                emitted.push({ event, options, settle });
                return { id: String(nextEventId++), settled };
            },
        },
        handlers: {
            list: async () => [{ slashPath: "/chat/web" }, { slashPath: "/mail/draft" }],
            resolve: async (topic: string) => (topic === "mail:draft" ? {} : null),
        },
        log: new MockLogger(),
    };
    return {
        deps: deps as unknown as ConstructorParameters<typeof ChatHub>[0],
        emitted,
        appended,
        queries,
        deliver: (message: ChatMessage) => {
            if (handler === null) {
                throw new Error("not subscribed");
            }
            return handler(message);
        },
    };
}

/**
 * A stored message.
 *
 * @param id Message id.
 * @param eventId Event id.
 * @param role Role.
 * @returns The message.
 */
function message(id: string, eventId: string, role: "user" | "assistant"): ChatMessage {
    return {
        id,
        eventId,
        role,
        textContent: `${role} ${id}`,
        createdAt: new Date("2026-11-05T10:00:00Z"),
        deliveredAt: null,
    };
}

/** Let pending promise callbacks run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("ChatHub", () => {
    it("sends plain messages as chat events and direct calls as exact-topic runs", async () => {
        const host = fakeHost();
        const hub = new ChatHub(host.deps);
        await hub.start();
        await hub.send("  hello  ");
        await hub.send("/mail/draft to Jürgen");
        assert.deepEqual(
            host.emitted.map((entry) => entry.event),
            [
                {
                    priority: 100,
                    preferredChatChannelId: "web",
                    privileged: true,
                    outputChatOnFailure: true,
                    topic: "chat:web",
                    isChat: true,
                    prompt: "hello",
                },
                {
                    priority: 100,
                    preferredChatChannelId: "web",
                    privileged: true,
                    outputChatOnFailure: true,
                    topic: "mail:draft",
                    isExactTopic: true,
                    isChat: false,
                    prompt: "to Jürgen",
                    userChatMessage: "/mail/draft to Jürgen",
                },
            ],
        );
        await hub.stop();
    });

    it("refuses empty lines, builtins and unknown handlers", async () => {
        const hub = new ChatHub(fakeHost().deps);
        await assert.rejects(hub.send("   "), ChatInputError);
        await assert.rejects(hub.send("/clear"), /handled by the chat page/);
        await assert.rejects(hub.send("/nope/x hi"), /no handler found for \/nope\/x/);
    });

    it("streams turn progress and messages to every client, with a snapshot on connect", async () => {
        const host = fakeHost();
        const hub = new ChatHub(host.deps);
        await hub.start();
        const first: ChatServerEvent[] = [];
        hub.addClient((event) => first.push(event));
        const eventId = await hub.send("hi");
        const { options } = host.emitted[0] as (typeof host.emitted)[number];
        options?.onAgentRun?.({
            id: "7",
            parentAgentrunId: null,
            topic: "chat:web",
            model: "featherless/m",
            state: "running",
            error: null,
        } as AgentRunRow);
        options?.onStep?.({
            agentRunId: "7",
            stepNumber: 0,
            reasoningText: "think",
            resultText: "",
            toolCalls: [
                {
                    toolCallId: "a",
                    toolName: "tool_call",
                    input: { name: "mail_send", arguments: { to: "x" } },
                },
            ],
            toolResults: [{ toolCallId: "a", output: "sent" }],
        } as unknown as StepResultRow);

        const second: ChatServerEvent[] = [];
        hub.addClient((event) => second.push(event));
        const snapshot = second[0];
        assert.equal(snapshot?.type, "snapshot");
        const turn = snapshot?.type === "snapshot" ? snapshot.turns[0] : undefined;
        assert.equal(turn?.eventId, eventId);
        assert.deepEqual(turn?.steps, [
            {
                agentRunId: "7",
                stepNumber: 1,
                reasoning: "think",
                text: null,
                tools: [
                    {
                        id: "a",
                        name: "mail_send",
                        input: '{"to":"x"}',
                        output: "sent",
                        isError: false,
                    },
                ],
            },
        ]);

        assert.equal(await host.deliver(message("5", eventId, "assistant")), true);
        assert.deepEqual([first.at(-1)?.type, second.at(-1)?.type], ["message", "message"]);
        await hub.stop();
    });

    it("marks assistant messages delivered only while a tab is connected", async () => {
        const host = fakeHost();
        const hub = new ChatHub(host.deps);
        await hub.start();
        assert.equal(await host.deliver(message("1", "9", "assistant")), false);
        assert.equal(await host.deliver(message("2", "9", "user")), true);
        const disconnect = hub.addClient(() => {});
        assert.equal(await host.deliver(message("3", "9", "assistant")), true);
        disconnect();
        assert.equal(await host.deliver(message("4", "9", "assistant")), false);
        await hub.stop();
    });

    it("appends the result text as reply only when the run wrote no chat message", async () => {
        const host = fakeHost();
        const hub = new ChatHub(host.deps);
        await hub.start();
        const silent = await hub.send("/mail/draft x");
        const chatty = await hub.send("hi");
        await host.deliver(message("1", chatty, "assistant"));
        host.emitted[0]?.settle.resolve("  draft saved ");
        host.emitted[1]?.settle.resolve("hello back");
        await flush();
        assert.deepEqual(host.appended, [{ eventId: silent, text: "draft saved" }]);

        const events: ChatServerEvent[] = [];
        hub.addClient((event) => events.push(event));
        const snapshot = events[0];
        assert.deepEqual(
            snapshot?.type === "snapshot" ? snapshot.turns.map((turn) => turn.state) : [],
            ["done", "done"],
        );
        await hub.stop();
    });

    it("marks a failed turn with the error", async () => {
        const host = fakeHost();
        const hub = new ChatHub(host.deps);
        await hub.start();
        const events: ChatServerEvent[] = [];
        hub.addClient((event) => events.push(event));
        await hub.send("hi");
        host.emitted[0]?.settle.reject(new Error("model exploded"));
        await flush();
        const last = events.at(-1);
        assert.equal(last?.type === "turn" ? last.turn.error : null, "model exploded");
        assert.deepEqual(host.appended, []);
        await hub.stop();
    });

    it("pages the history and reports older messages", async () => {
        const host = fakeHost([
            message("1", "1", "user"),
            message("2", "1", "assistant"),
            message("3", "2", "user"),
        ]);
        const hub = new ChatHub(host.deps);
        const page = await hub.history(undefined, 2);
        assert.deepEqual(
            page.messages.map((entry) => entry.id),
            ["2", "3"],
        );
        assert.equal(page.hasMore, true);
        assert.deepEqual(host.queries, [{ channelId: "web", beforeId: undefined, limit: 3 }]);
    });
});

describe("buildChatController", () => {
    it("validates input and answers 400 with the hub's message", async () => {
        const host = fakeHost();
        const hub = new ChatHub(host.deps);
        await hub.start();
        const app = buildChatController(() => hub, { handle: async (c) => c.text("page") });
        const post = (body: string) =>
            app.request("/api/messages", {
                method: "POST",
                body,
                headers: { "content-type": "application/json" },
            });

        const ok = await post(JSON.stringify({ text: "hi" }));
        assert.equal(ok.status, 202);
        assert.deepEqual(await ok.json(), { eventId: "100" });
        const unknown = await post(JSON.stringify({ text: "/nope" }));
        assert.equal(unknown.status, 400);
        assert.match((await unknown.json()).error, /no handler found/);
        assert.equal((await post("not json")).status, 400);
        assert.equal((await app.request("/api/messages?limit=0")).status, 400);
        assert.equal((await app.request("/api/messages?before=abc")).status, 400);
        assert.deepEqual(await (await app.request("/api/handlers")).json(), {
            handlers: ["/chat/web", "/mail/draft"],
            builtins: ["/clear"],
        });
        assert.equal(await (await app.request("/page/page.js")).text(), "page");
        await hub.stop();
    });

    it("streams a snapshot and live events over SSE", async () => {
        const host = fakeHost();
        const hub = new ChatHub(host.deps);
        await hub.start();
        const app = buildChatController(() => hub, { handle: async (c) => c.text("page") });
        const controller = new AbortController();
        const res = await app.request("/api/events", { signal: controller.signal });
        assert.equal(res.headers.get("content-type"), "text/event-stream");
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let text = "";
        const readUntil = async (pattern: RegExp) => {
            while (!pattern.test(text)) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                text += decoder.decode(value);
            }
        };
        await readUntil(/event: snapshot/);
        await host.deliver(message("1", "9", "assistant"));
        await readUntil(/event: message/);
        assert.match(text, /"text":"assistant 1"/);
        controller.abort();
        await reader.cancel();
        await hub.stop();
    });
});
