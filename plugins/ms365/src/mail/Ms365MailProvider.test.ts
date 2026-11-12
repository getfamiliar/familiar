import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { HostContext, OutgoingMailAttachment } from "@getfamiliar/shared";
import { setActiveLogins } from "../auth/ActiveLogins.js";
import type { LoginStore } from "../auth/LoginStore.js";
import { Ms365MailProvider } from "./Ms365MailProvider.js";

const MAILBOX = "me@example.com";

interface Call {
    readonly method: string;
    readonly path: string;
    readonly body: Record<string, unknown> | null;
}

const realFetch = globalThis.fetch;

/**
 * Replace fetch with a scripted responder, recording every Graph call
 * by method and path (below `/users/<mailbox>`).
 */
function mockFetch(respond: (call: Call) => Response): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const call: Call = {
            method: init?.method ?? "GET",
            path: decodeURIComponent(url.pathname).replace(/^\/v1\.0\/users\/[^/]+/, ""),
            body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        };
        calls.push(call);
        return respond(call);
    }) as typeof fetch;
    return calls;
}

/** Graph stub: draft creation returns an id, everything else 202/204. */
function graphOk(call: Call): Response {
    if (
        call.method === "POST" &&
        /\/(messages|createReply|createReplyAll|createForward)$/.test(call.path)
    ) {
        return Response.json({ id: "draft-1" }, { status: 201 });
    }
    return new Response(null, { status: 202 });
}

const ATTACHMENT: OutgoingMailAttachment = {
    name: "report.pdf",
    contentType: "application/pdf",
    contents: Buffer.from("%PDF"),
};

function provider(): Ms365MailProvider {
    const ctx = {
        getMailStyleTemplate: async () => undefined,
        logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    } as unknown as HostContext;
    return new Ms365MailProvider(ctx);
}

beforeEach(() => {
    const store = {
        byUpn: (upn: string) =>
            upn === MAILBOX ? { getAccessTokenSilent: async () => "TOKEN" } : undefined,
    } as unknown as LoginStore;
    setActiveLogins(store);
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

/** Method + path of every call, for compact order assertions. */
function trace(calls: readonly Call[]): string[] {
    return calls.map((c) => `${c.method} ${c.path}`);
}

describe("Ms365MailProvider attachments", () => {
    it("sends a new mail without attachments in one sendMail request", async () => {
        const calls = mockFetch(graphOk);
        await provider().sendNew(MAILBOX, {
            to: ["a@example.com"],
            cc: [],
            subject: "s",
            bodyMarkdown: "b",
            attachments: [],
        });
        assert.deepEqual(trace(calls), ["POST /sendMail"]);
    });

    it("sends a new mail with attachments via draft, attach, send", async () => {
        const calls = mockFetch(graphOk);
        await provider().sendNew(MAILBOX, {
            to: ["a@example.com"],
            cc: [],
            subject: "s",
            bodyMarkdown: "b",
            attachments: [ATTACHMENT, { ...ATTACHMENT, name: "second.pdf" }],
        });
        assert.deepEqual(trace(calls), [
            "POST /messages",
            "POST /messages/draft-1/attachments",
            "POST /messages/draft-1/attachments",
            "POST /messages/draft-1/send",
        ]);
        assert.deepEqual(calls[1].body, {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: "report.pdf",
            contentType: "application/pdf",
            contentBytes: Buffer.from("%PDF").toString("base64"),
        });
    });

    it("sends a reply with attachments via createReply, attach, send", async () => {
        const calls = mockFetch(graphOk);
        await provider().sendReply(MAILBOX, "msg-1", {
            bodyMarkdown: "b",
            replyAll: true,
            attachments: [ATTACHMENT],
        });
        assert.deepEqual(trace(calls), [
            "POST /messages/msg-1/createReplyAll",
            "POST /messages/draft-1/attachments",
            "POST /messages/draft-1/send",
        ]);
    });

    it("sends a forward with attachments via createForward, attach, send", async () => {
        const calls = mockFetch(graphOk);
        await provider().sendForward(MAILBOX, "msg-1", {
            to: ["a@example.com"],
            cc: [],
            commentMarkdown: "",
            attachments: [ATTACHMENT],
        });
        assert.deepEqual(trace(calls), [
            "POST /messages/msg-1/createForward",
            "POST /messages/draft-1/attachments",
            "POST /messages/draft-1/send",
        ]);
    });

    it("attaches files to a plain draft without sending it", async () => {
        const calls = mockFetch(graphOk);
        const id = await provider().draftReply(MAILBOX, "msg-1", {
            bodyMarkdown: "b",
            replyAll: false,
            attachments: [ATTACHMENT],
        });
        assert.equal(id, "draft-1");
        assert.deepEqual(trace(calls), [
            "POST /messages/msg-1/createReply",
            "POST /messages/draft-1/attachments",
        ]);
    });

    it("deletes the draft and does not send when an upload fails", async () => {
        const calls = mockFetch((call) =>
            call.path.endsWith("/attachments")
                ? Response.json({ error: { code: "ErrorQuotaExceeded" } }, { status: 400 })
                : graphOk(call),
        );
        await assert.rejects(
            provider().sendNew(MAILBOX, {
                to: ["a@example.com"],
                cc: [],
                subject: "s",
                bodyMarkdown: "b",
                attachments: [ATTACHMENT],
            }),
        );
        assert.deepEqual(trace(calls), [
            "POST /messages",
            "POST /messages/draft-1/attachments",
            "DELETE /messages/draft-1",
        ]);
    });
});
