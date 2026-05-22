import { Buffer } from "node:buffer";
import { GraphClient, type GraphMailMessageWithBody } from "../graph/GraphClient.js";
import { FOLDER_IDS } from "./Folders.js";
import type { MailboxTarget } from "./MailboxMap.js";

/**
 * One example mail kept after filtering, ready to inline into the
 * template-extraction prompt. `innerHtml` already has the quoted
 * original stripped and is capped at {@link SampleOptions.maxInlineBytes}.
 */
export interface SentExample {
    readonly kind: MailKind;
    readonly subject: string;
    readonly sentDateTime: string;
    readonly innerHtml: string;
    /**
     * `body.contentType` as Graph returned it — `"html"` or `"text"`,
     * lowercased. The deterministic `usePlainText` check in the
     * template extractor counts these to find the dominant value
     * without asking the model.
     */
    readonly contentType: string;
}

/**
 * Verbose-debug write sink. Called once per emitted line — the CLI's
 * `-v` flag wires it to `process.stdout.write(line + "\n")`. Undefined
 * everywhere else, so the daemon's boot pass and cron pass stay silent.
 */
export type DebugSink = (line: string) => void;

/**
 * What relation the sampled mail has to a prior thread. Used by every
 * caller that wants to bucket the user's outbound mail (template
 * extraction needs separate templates per kind, writing-style analysis
 * may weight kinds differently, etc.).
 */
export type MailKind = "reply" | "forward" | "new";

/** All three kinds in a stable iteration order. */
export const MAIL_KINDS: readonly MailKind[] = ["reply", "forward", "new"];

/**
 * Default drop-threshold on the raw HTML body *before* quote-stripping.
 * Long mails are usually forwarded chains with embedded images that
 * bloat downstream prompts without informing them; the sampler drops
 * them wholesale at this size. Exported so callers that need longer
 * examples can construct their `SampleOptions.maxRawBytes` relative to
 * this baseline.
 */
export const DEFAULT_MAX_RAW_BYTES = 40_000;

/**
 * Default per-example byte cap applied *after* quote-stripping. Sized
 * for the template-extraction prompt (signature wrapper + a little body
 * room). Writing-style analysis or other body-heavy callers can dial up
 * via `SampleOptions.maxInlineBytes`.
 */
export const DEFAULT_MAX_INLINE_BYTES = 12_000;

/**
 * Per-run tally of why messages were kept or dropped. Surfaced on
 * {@link SampleResult.summary} so callers (and operators reading the
 * extractor log) can see which filter gate is over-aggressive when
 * buckets don't fill — the alternative is staring at `-v` output and
 * counting by hand.
 */
export interface SampleSummary {
    /** Total messages pulled off Graph's iterator before the loop ended. */
    readonly scanned: number;
    /** Messages that made it into one of the three buckets. */
    readonly kept: number;
    /** Dropped because `isCalendarInvite` returned true. */
    readonly droppedAsMeeting: number;
    /** Dropped because the raw HTML body exceeded `maxRawBytes`. */
    readonly droppedAsOversize: number;
    /** Dropped because the relevant per-kind bucket was already full. */
    readonly droppedAsBucketFull: number;
    /** Dropped because the stripped body was empty (typically "+1" replies). */
    readonly droppedAsEmptyAfterStrip: number;
}

/** What {@link SentSampler.sample} returns. */
export interface SampleResult {
    /** Per-kind examples after filtering. */
    readonly buckets: Record<MailKind, readonly SentExample[]>;
    /** Per-run drop tally — see {@link SampleSummary}. */
    readonly summary: SampleSummary;
}

/** Knobs accepted by {@link SentSampler.sample}. */
export interface SampleOptions {
    /**
     * Cap on examples kept per kind. The sampler stops scanning as soon
     * as every kind has hit this number (or the hard scan cap is
     * reached). `0` or negative short-circuits to three empty buckets.
     */
    readonly perKind: number;
    /**
     * Per-example byte cap applied *after* quote-stripping. Defaults to
     * {@link DEFAULT_MAX_INLINE_BYTES}. Larger values keep more of the
     * original body when the soft truncation kicks in — useful for
     * writing-style analysis, expensive for prompt-budget callers.
     */
    readonly maxInlineBytes?: number;
    /**
     * Drop-threshold on the raw HTML body *before* quote-stripping.
     * Defaults to {@link DEFAULT_MAX_RAW_BYTES}. Callers that bump
     * `maxInlineBytes` should usually bump this proportionally so a
     * 60 KB mail isn't dropped by the raw sieve before reaching the
     * inline-cap step.
     */
    readonly maxRawBytes?: number;
}

/**
 * Worst-case ceiling on how many Sent Items messages we'll scan to
 * fill the three per-kind buckets. The sampler stops as soon as every
 * bucket has `perKind` examples (so a healthy Sent folder typically
 * costs one page). When buckets *won't* fill — e.g. the user only ever
 * replies to meeting threads and we now drop those — the cap stops the
 * scan before Graph's per-mailbox rate limit bites. 150 ≈ a page and
 * a half, enough headroom for normal mailboxes, conservative enough
 * to fail fast on degenerate ones.
 */
const HARD_SCAN_CAP = 150;

/**
 * Markers Outlook (and friends) place at the start of a quoted original
 * in an HTML body. Listed in detection priority — the earliest match
 * across all four wins. Pre-compiled here so {@link stripQuotedOriginal}
 * stays cheap per example.
 *
 *  - `<div id="appendonsend">` — exact insertion point above the
 *    quoted block on Outlook web / desktop. Strongest signal.
 *  - `<div style="border-top:...">` — the bordered divider Outlook
 *    draws above the quoted `From: / Sent: / To:` block on classic
 *    replies and forwards.
 *  - `<blockquote ...>` — used by Outlook mobile / OWA variants and
 *    by external senders we replied to.
 *  - `<hr>` whose immediate next sibling carries `From:` / `Sent:` —
 *    the plain-text forward divider fallback.
 */
const APPEND_ON_SEND_RE = /<div\b[^>]*\bid\s*=\s*["']?appendonsend["']?[^>]*>/i;
const BORDER_TOP_DIV_RE = /<div\b[^>]*\bstyle\s*=\s*["'][^"']*border-top:[^"']*["'][^>]*>/i;
const BLOCKQUOTE_RE = /<blockquote\b/i;
const HR_FROM_RE = /<hr\b[^>]*\/?>(\s|<[^>]+>)*?\s*(?:From:|Sent:|Von:|Gesendet:)/i;

/** Subject prefixes that indicate a forward across common Outlook locales. */
const FORWARD_PREFIXES = ["fwd:", "fw:", "wg:", "tr:", "rv:"];

/**
 * Subject prefixes that indicate a reply across common Outlook
 * locales. Used as a fallback when neither `conversationIndex` nor the
 * `In-Reply-To` / `References` headers settle the matter.
 *
 * - `re:` — en, default
 * - `aw:` / `antw:` — de, nl
 * - `r:` — it
 * - `rv:` — es (also forward in some locales — we prefer `re:` for ambiguity)
 * - `rép:` / `rep:` — fr
 * - `sv:` — sv, da
 */
const REPLY_PREFIXES = ["re:", "aw:", "antw:", "rép:", "rep:", "sv:", "r:"];

/**
 * Length (in raw bytes, after base64 decoding) of the
 * `conversationIndex` field that Outlook stamps on the root of a
 * thread. Replies append 5 bytes each, so anything strictly longer
 * than this is a reply. See
 * https://learn.microsoft.com/openspecs/exchange_server_protocols/ms-oxomsg/9e994fbb-b839-495f-84e3-2c8c2c0d951b
 */
const CONVERSATION_INDEX_ROOT_BYTES = 22;

/**
 * Sampler for one mailbox's Sent Items folder. Pulls the most recent
 * messages, filters out calendar invites and oversize chains,
 * classifies each as reply / forward / new, strips the auto-quoted
 * original, and returns up to `exampleCount` examples per kind.
 *
 * Stateless across calls — every `sample()` invocation re-fetches from
 * Graph. Cheap enough at 100-message page size, and gives the
 * downstream extractor a fresh view if the user's style changed.
 */
export class SentSampler {
    private readonly target: MailboxTarget;
    private readonly debug: DebugSink | undefined;

    constructor(target: MailboxTarget, debug?: DebugSink) {
        this.target = target;
        this.debug = debug;
    }

    /**
     * Walk the target mailbox's Sent Items, filter, classify, and
     * return up to `exampleCount` examples per template kind. Iterates
     * Graph's pagination lazily — stops as soon as every bucket is
     * full so a healthy Sent folder typically costs one page. Caps the
     * total scan at {@link HARD_SCAN_CAP} so a pathological mailbox
     * (only calendar invites, only forwarded mega-chains) doesn't keep
     * paging indefinitely. Categories left empty after the cap come
     * back as empty arrays — the caller decides whether to emit an
     * extraction event for that kind.
     */
    async sample(options: SampleOptions): Promise<SampleResult> {
        const perKind = options.perKind;
        const counters = {
            scanned: 0,
            kept: 0,
            droppedAsMeeting: 0,
            droppedAsOversize: 0,
            droppedAsBucketFull: 0,
            droppedAsEmptyAfterStrip: 0,
        };
        if (perKind <= 0) {
            return {
                buckets: { reply: [], forward: [], new: [] },
                summary: counters,
            };
        }
        const maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
        const maxRawBytes = options.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES;
        const verbose = this.debug !== undefined;
        const client = new GraphClient(() => this.target.auth.getAccessTokenSilent());
        const buckets: Record<MailKind, SentExample[]> = { reply: [], forward: [], new: [] };
        for await (const listMessage of client.iterateFolderMessages(
            this.target.mailbox,
            FOLDER_IDS.sent,
            HARD_SCAN_CAP,
        )) {
            counters.scanned += 1;

            // --- Cheap pre-filter pass --------------------------------
            // Drop obvious losers using only the data the list call
            // already gave us — subject, conversationIndex, body, and
            // whatever (truncated) `internetMessageHeaders` Graph chose
            // to include. Skipped in verbose mode so the operator can
            // see the full MIME headers for every scanned message.
            if (!verbose) {
                if (isCalendarInvite(listMessage)) {
                    this.decision("dropped (calendar invite — list-call signal)");
                    counters.droppedAsMeeting += 1;
                    continue;
                }
                const cheapBytes = Buffer.byteLength(listMessage.body?.content ?? "", "utf8");
                if (cheapBytes > maxRawBytes) {
                    this.decision(`dropped (oversize: ${cheapBytes} bytes > ${maxRawBytes})`);
                    counters.droppedAsOversize += 1;
                    continue;
                }
                const cheapKind = classifyKind(listMessage);
                if (buckets[cheapKind].length >= perKind) {
                    this.decision(
                        `dropped (bucket "${cheapKind}" already full — cheap classification)`,
                    );
                    counters.droppedAsBucketFull += 1;
                    continue;
                }
            }

            // --- Upgrade with MIME headers ----------------------------
            // Graph's list-call `internetMessageHeaders` is unreliable
            // (sometimes 0 entries even when the message has headers),
            // so once a message survives the cheap pass we fetch the
            // MIME `$value` blob and re-augment with the parsed
            // headers. That recovers the `MeetingMessage` signal and
            // `In-Reply-To` / `References` for downstream classifier
            // use without paying the per-message GET on obvious drops.
            const rawMime = await client.getMessageMimeHeaders(this.target.mailbox, listMessage.id);
            const parsedHeaders =
                rawMime !== null
                    ? parseRfc822Headers(rawMime)
                    : (listMessage.internetMessageHeaders ?? []);
            const message: GraphMailMessageWithBody = {
                ...listMessage,
                internetMessageHeaders: parsedHeaders,
            };
            await this.dumpVerbose(message, rawMime);

            if (isCalendarInvite(message)) {
                this.decision("dropped (calendar invite — full MIME signal)");
                counters.droppedAsMeeting += 1;
                continue;
            }
            const rawHtml = message.body?.content ?? "";
            const rawBytes = Buffer.byteLength(rawHtml, "utf8");
            if (rawBytes > maxRawBytes) {
                this.decision(`dropped (oversize: ${rawBytes} bytes > ${maxRawBytes})`);
                counters.droppedAsOversize += 1;
                continue;
            }
            const kind = classifyKind(message);
            if (buckets[kind].length >= perKind) {
                this.decision(`dropped (bucket "${kind}" already full)`);
                counters.droppedAsBucketFull += 1;
                continue;
            }
            const stripped = stripQuotedOriginal(rawHtml);
            const trimmed = capBytes(stripped, maxInlineBytes);
            if (trimmed.trim().length === 0) {
                // Stripping killed the whole body — keep nothing rather
                // than feed an empty example into the prompt.
                this.decision("dropped (empty after quote strip)");
                counters.droppedAsEmptyAfterStrip += 1;
                continue;
            }
            buckets[kind].push({
                kind,
                subject: message.subject ?? "",
                sentDateTime: message.sentDateTime,
                innerHtml: trimmed,
                contentType: (message.body?.contentType ?? "html").toLowerCase(),
            });
            counters.kept += 1;
            this.decision(`kept as ${kind}`);

            if (allBucketsFull(buckets, perKind)) {
                this.decision("all buckets full — stopping scan");
                break;
            }
        }
        return {
            buckets: { reply: buckets.reply, forward: buckets.forward, new: buckets.new },
            summary: counters,
        };
    }

    /**
     * Write one full record (headers + body) for `message` through the
     * debug sink when verbose is active. No-op when `debug` is undefined.
     * Takes the already-fetched raw MIME header blob so we don't pay for
     * a second `/$value` round-trip just to print it — sample() fetched
     * it once at the top of the loop, parsed it into the structured
     * headers the filter consumes, and hands it down here for display.
     */
    private async dumpVerbose(
        message: GraphMailMessageWithBody,
        rawMime: string | null,
    ): Promise<void> {
        if (this.debug === undefined) {
            return;
        }
        const write = this.debug;
        const indexBytes =
            typeof message.conversationIndex === "string" && message.conversationIndex.length > 0
                ? Buffer.from(message.conversationIndex, "base64").byteLength
                : 0;
        const parsedHeaders = message.internetMessageHeaders ?? [];
        const bodyContent = message.body?.content ?? "";
        const bodyBytes = Buffer.byteLength(bodyContent, "utf8");
        write("======== Sent message ========");
        write(`id:                ${message.id}`);
        write(`subject:           ${message.subject ?? "(null)"}`);
        write(`sentDateTime:      ${message.sentDateTime}`);
        write(`hasAttachments:    ${message.hasAttachments}`);
        write(`conversationId:    ${message.conversationId ?? "(missing)"}`);
        write(
            `conversationIndex: ${message.conversationIndex ?? "(missing)"}` +
                (indexBytes > 0 ? ` (${indexBytes} bytes decoded)` : ""),
        );
        write(`internetMessageHeaders (${parsedHeaders.length}, parsed from raw MIME):`);
        for (const header of parsedHeaders) {
            write(`  ${header.name ?? "(no name)"}: ${header.value ?? ""}`);
        }
        if (rawMime === null) {
            write("raw MIME headers: (Graph /$value returned no usable content)");
        } else {
            const lineCount = rawMime.split(/\r?\n/).length;
            write(`raw MIME headers (${rawMime.length} chars, ${lineCount} lines):`);
            write(rawMime);
        }
        write(`body.contentType: ${message.body?.contentType ?? "(missing)"}`);
        write(`body.content (${bodyBytes} bytes):`);
        write(bodyContent);
    }

    /** Write one `decision: ...` line through the debug sink. */
    private decision(reason: string): void {
        if (this.debug === undefined) {
            return;
        }
        this.debug(`decision: ${reason}`);
        this.debug("");
    }
}

/**
 * Parse a raw RFC 2822 header block (the part of a MIME message before
 * the first blank line — what {@link GraphClient.getMessageMimeHeaders}
 * returns) into `{ name, value }` pairs. Folded continuation lines (a
 * line beginning with SP or HTAB) are merged into the preceding
 * header's value with a single intervening space, per RFC 2822 §2.2.3.
 * Malformed lines (missing `:`) are silently skipped.
 *
 * We need this because Graph's parsed `internetMessageHeaders` field is
 * unreliable: it can come back with zero entries even when the message
 * objectively has the headers (e.g. `X-MS-Exchange-Organization-
 * TransportTrafficSubType` on meeting messages). Parsing the raw MIME
 * ourselves makes the filter and classifier ground-truth-driven.
 */
function parseRfc822Headers(blob: string): Array<{ name: string; value: string }> {
    const lines = blob.split(/\r?\n/);
    const out: Array<{ name: string; value: string }> = [];
    let current: { name: string; value: string } | null = null;
    for (const line of lines) {
        if (line.length === 0) {
            continue;
        }
        if (line.startsWith(" ") || line.startsWith("\t")) {
            if (current !== null) {
                const continuation = line.trim();
                current.value =
                    current.value.length === 0 ? continuation : `${current.value} ${continuation}`;
            }
            continue;
        }
        const idx = line.indexOf(":");
        if (idx <= 0) {
            continue;
        }
        if (current !== null) {
            out.push(current);
        }
        current = {
            name: line.slice(0, idx).trim(),
            value: line.slice(idx + 1).trim(),
        };
    }
    if (current !== null) {
        out.push(current);
    }
    return out;
}

/** True once every per-kind bucket has reached `perKind` entries. */
function allBucketsFull(
    buckets: Record<MailKind, readonly SentExample[]>,
    perKind: number,
): boolean {
    return (
        buckets.reply.length >= perKind &&
        buckets.forward.length >= perKind &&
        buckets.new.length >= perKind
    );
}

/**
 * True for any meeting-related message — invites, updates, responses,
 * cancellations, or in-thread chatter Exchange classifies as part of a
 * meeting. We skip them wholesale because they don't reflect how the
 * user normally writes mail (subjects are auto-generated, bodies are
 * often empty or filled with attendee blocks). Three signals, any one
 * is enough:
 *
 *  - Subject starts with `Invitation:` / `Accepted:` (Outlook's
 *    send-as-organiser / response auto-prefix).
 *  - `content-class` header starts with `schedule.meeting` or the
 *    `urn:content-classes:` namespace (set by Exchange on invite-shaped
 *    items).
 *  - `X-MS-Exchange-Organization-TransportTrafficSubType: MeetingMessage`
 *    header — Exchange's catch-all tag for anything the transport
 *    routed as a meeting message, which is the broadest of the three.
 */
function isCalendarInvite(message: GraphMailMessageWithBody): boolean {
    const subject = (message.subject ?? "").trim().toLowerCase();
    if (subject.startsWith("invitation:") || subject.startsWith("accepted:")) {
        return true;
    }
    for (const header of message.internetMessageHeaders ?? []) {
        if (typeof header.name !== "string" || typeof header.value !== "string") {
            continue;
        }
        const name = header.name.toLowerCase();
        const value = header.value.toLowerCase();
        if (name === "content-class") {
            if (value.startsWith("schedule.meeting") || value.startsWith("urn:content-classes:")) {
                return true;
            }
        }
        if (name === "x-ms-exchange-organization-transporttrafficsubtype") {
            if (value.trim() === "meetingmessage") {
                return true;
            }
        }
    }
    return false;
}

/**
 * Bucket a Sent message into reply / forward / new. Reply takes
 * priority — a forwarded reply is still a reply from the writer's
 * point of view.
 *
 * Signals, strongest to weakest:
 *
 * 1. **`conversationIndex` length.** Outlook stamps 22 bytes on a
 *    thread root and appends 5 per reply; anything longer is a reply.
 *    This is the canonical RFC-equivalent signal and is always set on
 *    Outlook-sent mail.
 * 2. **`In-Reply-To` / `References` headers.** Returned only on some
 *    Graph tenants (and depending on `$select` behaviour Microsoft
 *    has changed over time). Treated as a bonus signal in case the
 *    conversationIndex was missing for some reason.
 * 3. **Reply subject prefix.** `Re:` / `Aw:` / `Antw:` / `Sv:` /
 *    `Rép:` / `R:` etc. across Outlook locales. Final fallback so a
 *    thread that somehow lost its conversationIndex still ends up in
 *    the right bucket.
 *
 * Forward detection is subject-prefix based across the common Outlook
 * locales; new is the residual.
 */
export function classifyKind(message: GraphMailMessageWithBody): MailKind {
    if (isThreadedReply(message.conversationIndex)) {
        return "reply";
    }
    for (const header of message.internetMessageHeaders ?? []) {
        if (typeof header.name !== "string") {
            continue;
        }
        const name = header.name.toLowerCase();
        if (name === "in-reply-to" || name === "references") {
            return "reply";
        }
    }
    const subject = (message.subject ?? "").trim().toLowerCase();
    for (const prefix of REPLY_PREFIXES) {
        if (subject.startsWith(prefix)) {
            return "reply";
        }
    }
    for (const prefix of FORWARD_PREFIXES) {
        if (subject.startsWith(prefix)) {
            return "forward";
        }
    }
    return "new";
}

/**
 * True when the base64-decoded `conversationIndex` is longer than the
 * 22-byte thread-root header — i.e. at least one reply has been
 * appended. Missing / malformed values fall through as `false` (no
 * decision), letting the next signal weigh in.
 */
function isThreadedReply(conversationIndex: string | undefined): boolean {
    if (typeof conversationIndex !== "string" || conversationIndex.length === 0) {
        return false;
    }
    try {
        return Buffer.from(conversationIndex, "base64").byteLength > CONVERSATION_INDEX_ROOT_BYTES;
    } catch {
        return false;
    }
}

/**
 * Find the earliest occurrence of any of the four quote-start markers
 * in `html` and discard everything from that index onward. Returns the
 * original string when no marker is present (e.g. a clean "new" mail
 * with no quoted history at all).
 */
function stripQuotedOriginal(html: string): string {
    let cut = html.length;
    for (const re of [APPEND_ON_SEND_RE, BORDER_TOP_DIV_RE, BLOCKQUOTE_RE, HR_FROM_RE]) {
        const match = re.exec(html);
        if (match && match.index < cut) {
            cut = match.index;
        }
    }
    return html.slice(0, cut);
}

/**
 * Soft-truncate `html` to at most `maxBytes` UTF-8 bytes, cutting on
 * the last `>` we saw so we don't chop a tag in half. When no `>` is
 * present before the cut (long single-line HTML), falls back to the
 * raw byte-boundary slice; the agent can still read the prefix even
 * if it's syntactically incomplete.
 */
function capBytes(html: string, maxBytes: number): string {
    const buf = Buffer.from(html, "utf8");
    if (buf.byteLength <= maxBytes) {
        return html;
    }
    const sliced = buf.subarray(0, maxBytes).toString("utf8");
    const lastClose = sliced.lastIndexOf(">");
    if (lastClose > maxBytes / 2) {
        return sliced.slice(0, lastClose + 1);
    }
    return sliced;
}

// Re-exported for tests that want to exercise the helpers without
// going through Graph.
export const __test = {
    isCalendarInvite,
    isThreadedReply,
    stripQuotedOriginal,
    capBytes,
    parseRfc822Headers,
    CONVERSATION_INDEX_ROOT_BYTES,
};
