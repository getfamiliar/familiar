import path from "node:path";
import {
    type EmitHandle,
    EVENT_PRIORITY,
    type EventFile,
    type HostContext,
    type MailAttachmentMeta,
    type NewEvent,
} from "@getfamiliar/shared";
import {
    type DeltaPage,
    GraphClient,
    GraphError,
    type GraphMailMessage,
    type GraphAttachment as GraphRawAttachment,
} from "../graph/GraphClient.js";
import { flatAddress, formatAddress } from "./AddressFormat.js";
import { DeltaCursorStore } from "./DeltaCursorStore.js";
import type { MailboxTarget } from "./MailboxMap.js";
import { buildMailHit } from "./MessageShape.js";

/** Graph caps bodyPreview at 255 chars; equals → cap hit, more body upstream. */
const BODY_PREVIEW_TRUNCATION_LENGTH = 255;
/** Hard ceiling on delta pages per (mailbox, poll) so a runaway backlog can't park the loop. */
const MAX_PAGES_PER_POLL = 50;

/** Inputs the daemon hands the poller at construction. */
export interface MailPollerOptions {
    readonly ctx: HostContext;
    readonly log: (msg: string) => void;
    readonly emit: (event: NewEvent) => Promise<EmitHandle>;
    /**
     * Pre-resolved mailbox map shared with `Ms365MailProvider` so the
     * poller and the search tool agree on which mailboxes ms365
     * considers configured. Built once in `Ms365Daemon` from the
     * mail-config whitelist + the live login store.
     */
    readonly mailboxMap: readonly MailboxTarget[];
}

/**
 * Mail polling worker for Microsoft 365. Owns its own per-mailbox
 * delta cursor store. No interface, no provider abstraction —
 * mail-over-Graph is the only mail this plugin will ever speak.
 *
 * The login → mailboxes map is computed once by `Ms365Daemon` (shared
 * with `Ms365MailProvider`) and passed in via {@link MailPollerOptions}.
 */
export class MailPoller {
    private readonly opts: MailPollerOptions;
    private readonly cursorStore: DeltaCursorStore;

    private constructor(opts: MailPollerOptions, cursorStore: DeltaCursorStore) {
        this.opts = opts;
        this.cursorStore = cursorStore;
    }

    /**
     * Prepare the delta cursor store and return a poller bound to the
     * shared mailbox map. Returns `null` when the map is empty (no
     * reachable mailboxes) — daemon logs the reason and stays idle.
     */
    static async prepare(opts: MailPollerOptions): Promise<MailPoller | null> {
        const cursorStore = new DeltaCursorStore(
            path.join(opts.ctx.dataDir, "ms365", "mail", "delta.json"),
        );
        await cursorStore.load();
        if (opts.mailboxMap.length === 0) {
            opts.log("mail: no reachable mailboxes for any active login; nothing to poll");
            return null;
        }
        return new MailPoller(opts, cursorStore);
    }

    /** Run one poll pass for every mapped mailbox. */
    async pollOnce(): Promise<void> {
        for (const target of this.opts.mailboxMap) {
            try {
                await pollMailbox(this.opts, target, this.cursorStore);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.opts.log(
                    `mailbox ${target.mailbox} via ${target.upn}: poll error: ${message}`,
                );
            }
        }
    }
}

/**
 * Walk one mailbox forward from its current delta cursor, emit one
 * event per message, and persist the new delta link. On a 410 Gone
 * the cursor is dropped and the next poll starts fresh from "now" —
 * the bus-level idempotency-key dedup keeps re-walks safe.
 */
async function pollMailbox(
    opts: MailPollerOptions,
    target: MailboxTarget,
    cursorStore: DeltaCursorStore,
): Promise<void> {
    const client = new GraphClient(() => target.auth.getAccessTokenSilent());
    let cursor: string | null = cursorStore.get(target.upn, target.mailbox);
    let pages = 0;
    let nextDeltaLink: string | null = null;

    while (pages < MAX_PAGES_PER_POLL) {
        pages += 1;
        let page: DeltaPage;
        try {
            page = await client.listInboxDelta(target.mailbox, cursor);
        } catch (err) {
            if (err instanceof GraphError && err.status === 410) {
                opts.log(
                    `mailbox ${target.mailbox} via ${target.upn}: delta cursor expired (410); ` +
                        `resetting and re-walking from now`,
                );
                await cursorStore.drop(target.upn, target.mailbox);
                cursor = null;
                continue;
            }
            throw err;
        }

        for (const message of page.value) {
            if (message["@removed"]) {
                // Delta tombstone for a message that left the inbox between
                // polls. No body/recipients to emit; just acknowledge and move on.
                const reason = message["@removed"].reason ?? "removed";
                opts.log(`mailbox ${target.mailbox}: skipped tombstone ${message.id} (${reason})`);
                continue;
            }
            await emitMailEvent(opts, target, client, message);
        }

        if (page.deltaLink !== null) {
            nextDeltaLink = page.deltaLink;
            break;
        }
        if (page.nextLink === null) {
            // No more pages in this poll cycle and no fresh delta link —
            // shouldn't happen for a healthy delta walk, but guard so we
            // don't loop forever.
            break;
        }
        cursor = page.nextLink;
    }

    if (nextDeltaLink !== null) {
        await cursorStore.set(target.upn, target.mailbox, nextDeltaLink);
    }
}

/** Build the NewEvent for one message and hand it to the host. */
async function emitMailEvent(
    opts: MailPollerOptions,
    target: MailboxTarget,
    client: GraphClient,
    message: GraphMailMessage,
): Promise<void> {
    const fromDisplay = formatAddress(message.from ? flatAddress(message.from) : null);
    const subject = message.subject ?? "(no subject)";
    const preview = message.bodyPreview ?? "";
    const truncated = preview.length === BODY_PREVIEW_TRUNCATION_LENGTH;
    const prompt =
        `A new e-mail was received from ${fromDisplay} with subject "${subject}", see payload for metadata. ` +
        `The body starts with: ${preview}` +
        (truncated ? " Body is truncated. Use the mail_fetch_body tool to get the full body." : "");

    const fetched = await fetchAttachmentsForEvent(opts, target, client, message);

    const payload = buildMailHit({
        message,
        mailbox: target.mailbox,
        isShared: target.isShared,
        attachments: fetched?.metadata ?? null,
    });

    const event: NewEvent = {
        topic: "mail:ms365",
        prompt,
        priority: EVENT_PRIORITY.ASYNC,
        idempotencyKey: `mail:ms365:${message.internetMessageId}`,
        payload,
        files: fetched?.files,
    };
    await opts.emit(event);
}

interface FetchedAttachments {
    readonly metadata: readonly MailAttachmentMeta[];
    readonly files: readonly EventFile[];
}

async function fetchAttachmentsForEvent(
    opts: MailPollerOptions,
    target: MailboxTarget,
    client: GraphClient,
    message: GraphMailMessage,
): Promise<FetchedAttachments | null> {
    if (!message.hasAttachments) {
        return { metadata: [], files: [] };
    }
    try {
        const raw = await client.getAttachments(target.mailbox, message.id);
        return normalizeAttachments(raw);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        opts.log(
            `attachment fetch for ${target.mailbox}/${message.id} failed: ${reason}; ` +
                `emitting with attachments=null`,
        );
        return null;
    }
}

function normalizeAttachments(raw: readonly GraphRawAttachment[]): FetchedAttachments {
    if (raw.length === 0) {
        return { metadata: [], files: [] };
    }
    const meta: MailAttachmentMeta[] = [];
    const files: EventFile[] = [];
    const usedNames = new Set<string>();
    for (const item of raw) {
        if (item.id.length === 0 || item.name.length === 0) {
            continue;
        }
        meta.push({
            id: item.id,
            name: item.name,
            contentType: item.contentType,
            size: item.size,
            isInline: item.isInline,
        });
        if (item.isInline) {
            continue;
        }
        if (typeof item.contentBytes !== "string" || item.contentBytes.length === 0) {
            continue;
        }
        const safeName = sanitizeAttachmentName(item.name, item.id, usedNames);
        files.push({ name: safeName, contents: Buffer.from(item.contentBytes, "base64") });
    }
    return { metadata: meta, files };
}

/**
 * Make an attachment filename safe to land at `/scratch/<event-id>/`.
 * The host's emit guard rejects any name containing `/`, `\`, or `..`
 * outright. We replace separators with `_` and strip hidden-file
 * leading dots; empty results fall back to `attachment-<id>`.
 * Collisions get a `(2)`/`(3)`/… suffix before the extension.
 */
function sanitizeAttachmentName(name: string, id: string, used: Set<string>): string {
    let cleaned = name.replace(/[/\\]/g, "_").replace(/^\.+/, "");
    if (cleaned === "." || cleaned === "..") {
        cleaned = "";
    }
    if (cleaned.length === 0) {
        cleaned = `attachment-${id.replace(/[/\\]/g, "_")}`;
    }
    if (!used.has(cleaned)) {
        used.add(cleaned);
        return cleaned;
    }
    const dot = cleaned.lastIndexOf(".");
    const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
    const ext = dot > 0 ? cleaned.slice(dot) : "";
    for (let i = 2; i < 1000; i++) {
        const candidate = `${stem} (${i})${ext}`;
        if (!used.has(candidate)) {
            used.add(candidate);
            return candidate;
        }
    }
    const fallback = `${stem}-${id.replace(/[/\\]/g, "_")}${ext}`;
    used.add(fallback);
    return fallback;
}
