import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { GraphClient, type GraphMailMessageWithBody } from "../graph/GraphClient.js";
import type { MailboxTarget } from "./MailboxMap.js";
import { __test, classifyKind, SentSampler } from "./SentSampler.js";

const { isCalendarInvite, stripQuotedOriginal, capBytes, parseRfc822Headers } = __test;

test("isCalendarInvite catches Exchange schedule.meeting content-class", () => {
    const flagged = isCalendarInvite({
        id: "1",
        subject: "Lunch?",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
        internetMessageHeaders: [{ name: "Content-Class", value: "Schedule.Meeting.Request" }],
    });
    assert.equal(flagged, true);
});

test("isCalendarInvite catches Invitation: subject prefix", () => {
    const flagged = isCalendarInvite({
        id: "1",
        subject: "Invitation: project review @ Thu 13:00",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
    });
    assert.equal(flagged, true);
});

test("isCalendarInvite catches X-MS-Exchange-Organization-TransportTrafficSubType: MeetingMessage", () => {
    const flagged = isCalendarInvite({
        id: "1",
        subject: "Re: project review",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
        internetMessageHeaders: [
            {
                name: "X-MS-Exchange-Organization-TransportTrafficSubType",
                value: "MeetingMessage",
            },
        ],
    });
    assert.equal(flagged, true);
});

test("isCalendarInvite leaves regular mails alone", () => {
    const flagged = isCalendarInvite({
        id: "1",
        subject: "Quick question on the invoice",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
    });
    assert.equal(flagged, false);
});

test("classifyKind: conversationIndex > 22 bytes → reply (canonical Outlook signal)", () => {
    // 22-byte root + one 5-byte reply append = 27 bytes raw → encoded
    // string is 36 chars (with padding).
    const replyIndex = Buffer.alloc(27, 1).toString("base64");
    const k = classifyKind({
        id: "1",
        subject: "Just a thought",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
        conversationIndex: replyIndex,
    });
    assert.equal(k, "reply");
});

test("classifyKind: conversationIndex exactly 22 bytes → not a reply", () => {
    const rootIndex = Buffer.alloc(22, 1).toString("base64");
    const k = classifyKind({
        id: "1",
        subject: "Project plan",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
        conversationIndex: rootIndex,
    });
    assert.equal(k, "new");
});

test("classifyKind: Re: subject → reply (header-less fallback)", () => {
    const k = classifyKind({
        id: "1",
        subject: "Re: invoice for last quarter",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
    });
    assert.equal(k, "reply");
});

test("classifyKind: Aw: subject (German Outlook reply prefix) → reply", () => {
    const k = classifyKind({
        id: "1",
        subject: "Aw: Rechnung",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
    });
    assert.equal(k, "reply");
});

test("classifyKind: In-Reply-To header → reply", () => {
    const k = classifyKind({
        id: "1",
        subject: "Re: thing",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
        internetMessageHeaders: [{ name: "In-Reply-To", value: "<abc@x>" }],
    });
    assert.equal(k, "reply");
});

test("classifyKind: References header (even without In-Reply-To) → reply", () => {
    const k = classifyKind({
        id: "1",
        subject: "Re: thing",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
        internetMessageHeaders: [{ name: "References", value: "<abc@x> <def@x>" }],
    });
    assert.equal(k, "reply");
});

test("classifyKind: Fwd: subject → forward", () => {
    const k = classifyKind({
        id: "1",
        subject: "Fwd: invoice for review",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
    });
    assert.equal(k, "forward");
});

test("classifyKind: WG: (German Outlook forward prefix) → forward", () => {
    const k = classifyKind({
        id: "1",
        subject: "WG: Rechnung",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
    });
    assert.equal(k, "forward");
});

test("classifyKind: no reply headers + no forward prefix → new", () => {
    const k = classifyKind({
        id: "1",
        subject: "Project plan for next week",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
    });
    assert.equal(k, "new");
});

test("classifyKind: reply takes priority over forward subject", () => {
    // A forwarded reply still belongs in the reply bucket from the
    // writer's POV — keeps the templates representative.
    const k = classifyKind({
        id: "1",
        subject: "Fwd: Re: project plan",
        sentDateTime: "2026-05-21T12:00:00Z",
        hasAttachments: false,
        internetMessageHeaders: [{ name: "In-Reply-To", value: "<abc@x>" }],
    });
    assert.equal(k, "reply");
});

test('stripQuotedOriginal cuts at <div id="appendonsend">', () => {
    const html =
        `<div>Hi Anna,</div><div>Sounds good.</div><div>--<br>Bob</div>` +
        `<div id="appendonsend"></div><hr><div>From: anna@x</div>`;
    const stripped = stripQuotedOriginal(html);
    assert.ok(!stripped.includes("appendonsend"));
    assert.ok(!stripped.includes("From: anna@x"));
    assert.ok(stripped.includes("Bob"));
});

test('stripQuotedOriginal cuts at <div style="border-top:...">', () => {
    const html =
        `<p>Best,<br>Bob</p>` +
        `<div style="border-top:1px solid #ccc;padding-top:6pt;font-family:Calibri">` +
        `<b>From:</b> Anna</div>`;
    const stripped = stripQuotedOriginal(html);
    assert.ok(stripped.endsWith("</p>"), `got: ${stripped}`);
});

test("stripQuotedOriginal cuts at <blockquote>", () => {
    const html = `<p>Yes please.</p><blockquote>Original text</blockquote>`;
    assert.equal(stripQuotedOriginal(html), `<p>Yes please.</p>`);
});

test("stripQuotedOriginal cuts at <hr> followed by From:", () => {
    const html = `<p>OK</p><hr><div>From: anna@x</div>Sent: ...`;
    const stripped = stripQuotedOriginal(html);
    assert.ok(stripped.startsWith("<p>OK</p>"));
    assert.ok(!stripped.includes("From: anna@x"));
});

test("stripQuotedOriginal picks the earliest of multiple markers", () => {
    // border-top divider appears before the blockquote.
    const html =
        `<p>Done.</p>` +
        `<div style="border-top:1px solid black">From:</div>` +
        `<blockquote>...</blockquote>`;
    const stripped = stripQuotedOriginal(html);
    assert.equal(stripped, `<p>Done.</p>`);
});

test("stripQuotedOriginal leaves clean new mails untouched", () => {
    const html = `<p>Hello there.</p><p>Bob</p>`;
    assert.equal(stripQuotedOriginal(html), html);
});

test("parseRfc822Headers extracts simple name: value pairs", () => {
    const blob = `From: alice@x\r\nSubject: hello\r\nDate: Thu, 21 May 2026 08:37:08 +0000`;
    const parsed = parseRfc822Headers(blob);
    assert.deepEqual(parsed, [
        { name: "From", value: "alice@x" },
        { name: "Subject", value: "hello" },
        { name: "Date", value: "Thu, 21 May 2026 08:37:08 +0000" },
    ]);
});

test("parseRfc822Headers folds continuation lines (leading whitespace) into the prior value", () => {
    const blob =
        "Message-ID:\r\n        <BEZP281MB22931B23C@BEZP281MB2293.PROD.OUTLOOK.COM>\r\n" +
        'Content-Type: multipart/alternative;\r\n\tboundary="_000_BEZP281MB22931B23C_"';
    const parsed = parseRfc822Headers(blob);
    assert.deepEqual(parsed, [
        {
            name: "Message-ID",
            value: "<BEZP281MB22931B23C@BEZP281MB2293.PROD.OUTLOOK.COM>",
        },
        {
            name: "Content-Type",
            value: 'multipart/alternative; boundary="_000_BEZP281MB22931B23C_"',
        },
    ]);
});

test("parseRfc822Headers picks up X-MS-Exchange-Organization-TransportTrafficSubType the classifier missed", () => {
    // The exact failure mode the user hit: Graph's parsed
    // internetMessageHeaders comes back empty, but the raw MIME has
    // the MeetingMessage tag. Parsing the raw MIME ourselves recovers
    // the signal isCalendarInvite needs.
    const blob =
        "From: alice@x\r\n" +
        "X-MS-Exchange-Organization-TransportTrafficType: Email\r\n" +
        "X-MS-Exchange-Organization-TransportTrafficSubType: MeetingMessage";
    const parsed = parseRfc822Headers(blob);
    const flagged = isCalendarInvite({
        id: "1",
        subject: "Kennenlerncall",
        sentDateTime: "2026-05-21T08:37:08Z",
        hasAttachments: false,
        internetMessageHeaders: parsed,
    });
    assert.equal(flagged, true);
});

test("parseRfc822Headers skips malformed lines", () => {
    const blob = "From: alice@x\r\nthis is not a header\r\nSubject: hi";
    const parsed = parseRfc822Headers(blob);
    assert.deepEqual(parsed, [
        { name: "From", value: "alice@x" },
        { name: "Subject", value: "hi" },
    ]);
});

test("capBytes returns input unchanged when below limit", () => {
    const small = "<p>hi</p>";
    assert.equal(capBytes(small, 100), small);
});

test("capBytes soft-cuts on last `>` when one's reasonably close to the budget", () => {
    const html = "<p>line1</p><p>line2</p><p>line3</p><span>extra content</span>";
    const out = capBytes(html, 30);
    assert.ok(out.endsWith(">"), `expected tag-aligned slice, got: ${out}`);
    assert.ok(Buffer.byteLength(out, "utf8") <= 30);
});

test("capBytes falls back to raw byte slice when no close tag is near the budget", () => {
    // Single mega-attribute means the only `>` in the slice is way at
    // the front — function intentionally avoids that lopsided cut and
    // returns the raw slice instead.
    const html = `<p>${"x".repeat(200)}`;
    const out = capBytes(html, 50);
    assert.equal(Buffer.byteLength(out, "utf8"), 50);
});

/** Stub mailbox target — `auth` is never dereferenced because we patch the GraphClient methods. */
function makeTarget(): MailboxTarget {
    return {
        mailbox: "test@x.example",
        upn: "test@x.example",
        isShared: false,
        auth: {} as MailboxTarget["auth"],
    };
}

/**
 * Replace `GraphClient.prototype.iterateFolderMessages` with one that
 * yields the supplied messages, and stub `getMessageMimeHeaders` to
 * return `null` so the sampler falls back to whatever
 * `internetMessageHeaders` the fake message carries (`[]` by default).
 * Returns a restorer the caller invokes in `finally`.
 */
function stubGraph(messages: readonly GraphMailMessageWithBody[]): () => void {
    const origIterate = GraphClient.prototype.iterateFolderMessages;
    const origMime = GraphClient.prototype.getMessageMimeHeaders;
    GraphClient.prototype.iterateFolderMessages = async function* () {
        for (const m of messages) {
            yield m;
        }
    };
    GraphClient.prototype.getMessageMimeHeaders = async () => null;
    return () => {
        GraphClient.prototype.iterateFolderMessages = origIterate;
        GraphClient.prototype.getMessageMimeHeaders = origMime;
    };
}

test("sample({ perKind: 0 }) short-circuits to three empty buckets without hitting Graph", async () => {
    const sampler = new SentSampler(makeTarget());
    const out = await sampler.sample({ perKind: 0 });
    assert.deepEqual(out.buckets, { reply: [], forward: [], new: [] });
    assert.equal(out.summary.scanned, 0);
    assert.equal(out.summary.kept, 0);
});

test("sample honours maxInlineBytes override (caps inner HTML at 200 bytes, not the 12k default)", async () => {
    const restore = stubGraph([
        {
            id: "1",
            subject: "Project update",
            sentDateTime: "2026-05-21T12:00:00Z",
            hasAttachments: false,
            // ~1 KB raw body — well above the 200-byte override below
            // and well below the 40 KB default raw cap.
            body: { contentType: "html", content: `<p>${"x".repeat(1000)}</p>` },
            internetMessageHeaders: [],
        },
    ]);
    try {
        const out = await new SentSampler(makeTarget()).sample({
            perKind: 2,
            maxInlineBytes: 200,
        });
        const all = [...out.buckets.reply, ...out.buckets.forward, ...out.buckets.new];
        assert.equal(all.length, 1);
        assert.equal(out.summary.kept, 1);
        assert.equal(out.summary.scanned, 1);
        assert.ok(
            Buffer.byteLength(all[0].innerHtml, "utf8") <= 200,
            `expected innerHtml ≤ 200 bytes, got ${Buffer.byteLength(all[0].innerHtml, "utf8")}`,
        );
    } finally {
        restore();
    }
});

test("sample({ onlyKind: 'new' }) fills only the new bucket and drops the other kinds as bucket-full", async () => {
    const restore = stubGraph([
        {
            id: "1",
            subject: "Re: invoice",
            sentDateTime: "2026-05-21T12:00:00Z",
            hasAttachments: false,
            body: { contentType: "html", content: "<p>reply body</p>" },
            internetMessageHeaders: [{ name: "In-Reply-To", value: "<abc@x>" }],
        },
        {
            id: "2",
            subject: "Fwd: invoice",
            sentDateTime: "2026-05-21T12:01:00Z",
            hasAttachments: false,
            body: { contentType: "html", content: "<p>forward body</p>" },
            internetMessageHeaders: [],
        },
        {
            id: "3",
            subject: "Project plan for next week",
            sentDateTime: "2026-05-21T12:02:00Z",
            hasAttachments: false,
            body: { contentType: "html", content: "<p>fresh body</p>" },
            internetMessageHeaders: [],
        },
    ]);
    try {
        const out = await new SentSampler(makeTarget()).sample({ perKind: 3, onlyKind: "new" });
        assert.deepEqual(out.buckets.reply, []);
        assert.deepEqual(out.buckets.forward, []);
        assert.equal(out.buckets.new.length, 1);
        assert.equal(out.buckets.new[0].kind, "new");
        assert.equal(out.summary.kept, 1);
        // The reply and forward are dropped through the bucket-full gate
        // (effective cap 0 for off-target kinds).
        assert.equal(out.summary.droppedAsBucketFull, 2);
    } finally {
        restore();
    }
});

test("sample({ onlyKind }) stops scanning once the single target bucket is full", async () => {
    // Two 'new' mails, then a third the sampler must never reach because
    // the new bucket fills at perKind=1.
    const restore = stubGraph([
        {
            id: "1",
            subject: "First fresh mail",
            sentDateTime: "2026-05-21T12:00:00Z",
            hasAttachments: false,
            body: { contentType: "html", content: "<p>one</p>" },
            internetMessageHeaders: [],
        },
        {
            id: "2",
            subject: "Second fresh mail",
            sentDateTime: "2026-05-21T12:01:00Z",
            hasAttachments: false,
            body: { contentType: "html", content: "<p>two</p>" },
            internetMessageHeaders: [],
        },
    ]);
    try {
        const out = await new SentSampler(makeTarget()).sample({ perKind: 1, onlyKind: "new" });
        assert.equal(out.buckets.new.length, 1);
        assert.equal(out.summary.kept, 1);
        // Scan stopped after the first kept message — the second was
        // never pulled off the iterator.
        assert.equal(out.summary.scanned, 1);
    } finally {
        restore();
    }
});

test("sample honours maxRawBytes override (drops a 1 KB body when raw cap is 100)", async () => {
    const restore = stubGraph([
        {
            id: "1",
            subject: "Project update",
            sentDateTime: "2026-05-21T12:00:00Z",
            hasAttachments: false,
            body: { contentType: "html", content: `<p>${"x".repeat(1000)}</p>` },
            internetMessageHeaders: [],
        },
    ]);
    try {
        const out = await new SentSampler(makeTarget()).sample({
            perKind: 2,
            maxRawBytes: 100,
        });
        const total =
            out.buckets.reply.length + out.buckets.forward.length + out.buckets.new.length;
        assert.equal(total, 0, "1 KB body should be dropped before strip when raw cap is 100");
        assert.equal(out.summary.droppedAsOversize, 1);
        assert.equal(out.summary.scanned, 1);
    } finally {
        restore();
    }
});
