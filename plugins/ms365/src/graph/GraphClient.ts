/**
 * Minimal Microsoft Graph REST client — just the surface the plugin
 * needs (inbox delta, get message body, get attachments, draft, send,
 * move). Built directly on `fetch` so there's nothing between us and
 * the wire protocol: no SDK schema drift, no model mismatches against
 * Featherless, no overhead from the official `@microsoft/microsoft-graph-
 * client` package (which bundles its own auth flow we don't need).
 *
 * The client is stateless; the access token comes from a callback so
 * one client instance can serve multiple `GraphAuth` accounts if
 * needed — though in practice each `(login, mailbox)` poll path owns
 * its own client + auth pair. Calendar additions will share the same
 * client surface once they land.
 */
const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

/**
 * Fixed `$select` list used for every calendar event fetch (delta,
 * get-by-id). Kept in one place so the poller and the create-event
 * path return the same projection — `Mapping.fromGraph` then handles
 * exactly these fields and nothing else.
 */
const CALENDAR_EVENT_SELECT =
    "id,subject,start,end,originalStartTimeZone,isAllDay,isCancelled,showAs," +
    "sensitivity,importance,location,isOnlineMeeting,onlineMeeting,organizer," +
    "responseStatus,attendees,body,hasAttachments,seriesMasterId,type";

/**
 * Microsoft Graph's default message id format is **not stable across
 * folder moves** — moving a mail from Inbox to Archive mints a new id
 * for that message and the old one returns 404. The plugin caches
 * message ids on event emit (delta poll) and reuses them later from
 * agent tool calls, often after the triage handler has archived the
 * mail; without immutable ids those tool calls fail with
 * `ErrorItemNotFound`.
 *
 * Opting in via `Prefer: IdType="ImmutableId"` makes Graph return ids
 * that survive moves. The header has to be sent on every request that
 * either returns or consumes a message id — including the delta walk
 * — so the client always sets it. Delta cursors created before this
 * fix are invalid (Graph rejects mixed id types in delta); see
 * `DeltaCursorStore` for the schema-version guard that drops them on
 * load.
 */
const IMMUTABLE_ID_PREFER = 'IdType="ImmutableId"';

/** Token provider — async because msal-node's `acquireTokenSilent` is async. */
export type TokenProvider = () => Promise<string>;

/**
 * Narrow projection of a Graph calendar. Only the fields the poller
 * needs to seed the local `calendars` row; anything else is dropped
 * server-side via `$select`.
 */
export interface GraphCalendar {
    readonly id: string;
    readonly name: string;
    readonly isDefaultCalendar?: boolean;
    /** True when this is a calendar the signed-in user owns. */
    readonly canEdit?: boolean;
    readonly owner?: { readonly name?: string; readonly address?: string } | null;
}

/**
 * Narrow projection of a Graph calendar event. Mirrors the fields we
 * persist in `calendar_events`; `@removed` is preserved as a tombstone
 * marker on delta walks (cancellation / deletion). Times come back as
 * `{dateTime, timeZone}` pairs.
 */
export interface GraphCalendarEvent {
    readonly id: string;
    readonly subject?: string | null;
    readonly start?: { dateTime: string; timeZone: string } | null;
    readonly end?: { dateTime: string; timeZone: string } | null;
    readonly originalStartTimeZone?: string | null;
    readonly isAllDay?: boolean;
    readonly isCancelled?: boolean;
    readonly showAs?: string | null;
    readonly sensitivity?: string | null;
    readonly importance?: string | null;
    readonly location?: { displayName?: string } | null;
    readonly isOnlineMeeting?: boolean;
    readonly onlineMeeting?: { joinUrl?: string } | null;
    readonly organizer?: { emailAddress?: { name?: string; address?: string } } | null;
    readonly responseStatus?: { response?: string } | null;
    readonly attendees?: ReadonlyArray<{
        type?: string;
        status?: { response?: string };
        emailAddress?: { name?: string; address?: string };
    }>;
    readonly body?: { content?: string; contentType?: string } | null;
    readonly hasAttachments?: boolean;
    readonly seriesMasterId?: string | null;
    /** 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster'. */
    readonly type?: string | null;
    readonly "@removed"?: { readonly reason?: string };
}

/** One page of the calendar-view delta endpoint. */
export interface CalendarDeltaPage {
    readonly value: readonly GraphCalendarEvent[];
    readonly nextLink: string | null;
    readonly deltaLink: string | null;
}

/** Body shape for create-event. Only the fields we drive from the tool surface. */
export interface GraphCalendarEventCreate {
    readonly subject: string;
    readonly start: { dateTime: string; timeZone: string };
    readonly end: { dateTime: string; timeZone: string };
    readonly body?: { contentType: "HTML"; content: string };
    readonly location?: { displayName: string };
    readonly attendees?: ReadonlyArray<{
        type: "required" | "optional";
        emailAddress: { address: string; name?: string };
    }>;
    readonly showAs?: string;
    readonly sensitivity?: string;
    readonly reminderMinutesBeforeStart?: number;
    readonly isReminderOn?: boolean;
    readonly isOnlineMeeting?: boolean;
    readonly onlineMeetingProvider?: string;
}

/**
 * One inbox `delta` response from Graph. The shape mirrors the
 * `value`/`@odata.nextLink`/`@odata.deltaLink` envelope Graph returns
 * for `/users/{id}/mailFolders/inbox/messages/delta`. Either
 * `nextLink` (more pages remaining) or `deltaLink` (page chain done,
 * use this URL on the next poll) is set — never both.
 */
export interface DeltaPage {
    readonly value: readonly GraphMailMessage[];
    readonly nextLink: string | null;
    readonly deltaLink: string | null;
}

/**
 * Narrow projection of a Graph mail message. Only the fields the
 * poll loop emits land here; anything else is dropped server-side via
 * `$select`.
 */
export interface GraphMailMessage {
    readonly id: string;
    readonly internetMessageId: string;
    readonly subject: string | null;
    readonly receivedDateTime: string;
    readonly bodyPreview: string;
    readonly hasAttachments: boolean;
    /**
     * Opaque id of the mail folder this message currently lives in.
     * Always populated for real messages — both the search `$select` and
     * the delta `$select` request it. Absent only on tombstones (where
     * `@removed` is set and the rest of the projection is empty).
     */
    readonly parentFolderId?: string;
    readonly from: { readonly emailAddress: { name?: string; address: string } } | null;
    readonly toRecipients: ReadonlyArray<{ emailAddress: { name?: string; address: string } }>;
    readonly ccRecipients: ReadonlyArray<{ emailAddress: { name?: string; address: string } }>;
    /**
     * Present on delta tombstones — items returned for messages that left
     * the inbox between polls (deleted, moved). Tombstones carry only `id`
     * plus this marker; body, recipients, and `internetMessageId` are
     * omitted. Callers must filter these out before treating an item as
     * a real message.
     */
    readonly "@removed"?: { readonly reason?: string };
}

/**
 * Raw Graph attachment as returned by `?$expand=attachments(...)`.
 * `contentBytes` is base64 when Graph inlines the bytes — only present
 * for non-inline attachments under Graph's inline-bytes ceiling (~3 MB).
 */
export interface GraphAttachment {
    readonly id: string;
    readonly name: string;
    readonly contentType: string;
    readonly size: number;
    readonly isInline: boolean;
    readonly contentBytes?: string;
}

/** Recipient on a draft/send. `name` is optional. */
export interface GraphRecipient {
    readonly address: string;
    readonly name?: string;
}

/** Either an HTML-bodied draft or a send payload. */
export interface GraphOutgoing {
    readonly subject: string;
    /** HTML body — render markdown upstream via `renderMarkdownToHtml`. */
    readonly bodyHtml: string;
    readonly to: readonly GraphRecipient[];
    readonly cc?: readonly GraphRecipient[];
}

/**
 * Thrown when Graph returns a non-2xx response. The host-side log
 * still carries the full URL + raw body for diagnosis; the
 * agent-facing tool layer catches this and converts it into a
 * structured `{ok:false, error:{...}}` payload before returning to
 * the model (see `MailTools.ts`).
 *
 * 410 Gone on a delta URL is the documented "delta link expired,
 * start over" signal — the poll loop catches it and drops the cursor.
 */
export class GraphError extends Error {
    readonly status: number;
    readonly url: string;
    readonly body: string;
    /** Graph's `error.code` if the body decoded as JSON; `null` otherwise. */
    readonly code: string | null;
    /** Graph's `error.message` if the body decoded as JSON; the raw text otherwise. */
    readonly graphMessage: string;

    constructor(status: number, url: string, body: string) {
        const decoded = decodeGraphErrorBody(body);
        super(
            `Graph ${status} ${decoded.code ?? "error"}: ${decoded.message.slice(0, 500)} ` +
                `(${url})`,
        );
        this.status = status;
        this.url = url;
        this.body = body;
        this.code = decoded.code;
        this.graphMessage = decoded.message;
    }
}

/**
 * Pull `{code, message}` out of a Graph error body if possible. Falls
 * back to the raw body string when the response isn't JSON-shaped —
 * Graph occasionally returns HTML on gateway errors.
 */
function decodeGraphErrorBody(body: string): { code: string | null; message: string } {
    try {
        const parsed = JSON.parse(body) as {
            error?: { code?: unknown; message?: unknown };
        };
        const code = typeof parsed.error?.code === "string" ? parsed.error.code : null;
        const message = typeof parsed.error?.message === "string" ? parsed.error.message : body;
        return { code, message };
    } catch {
        return { code: null, message: body };
    }
}

/**
 * Convert the plugin's `GraphRecipient` shape to Graph's
 * `{ emailAddress: { address, name? } }` wire shape. The `name` field
 * is omitted when unset so we don't send empty strings.
 */
/**
 * Project a Graph recipient array (`toRecipients` / `ccRecipients`) to
 * a flat string list, dropping entries whose `emailAddress.address` is
 * missing. Used by `getMessageRecipients`; the missing-entry case is
 * "defensive but not normal" — Graph always returns the address on a
 * mail with a real recipient.
 */
function pickAddresses(
    raw: ReadonlyArray<{ emailAddress?: { address?: string } }> | undefined,
): readonly string[] {
    if (!raw) {
        return [];
    }
    const out: string[] = [];
    for (const entry of raw) {
        const addr = entry.emailAddress?.address;
        if (typeof addr === "string" && addr.length > 0) {
            out.push(addr);
        }
    }
    return out;
}

function mapGraphRecipients(
    recipients: readonly GraphRecipient[],
): ReadonlyArray<{ emailAddress: { address: string; name?: string } }> {
    return recipients.map((r) => ({
        emailAddress: r.name ? { address: r.address, name: r.name } : { address: r.address },
    }));
}

/**
 * Direct Graph REST client. All Graph calls in the plugin go through
 * here so there's exactly one place that knows the URL prefix, the
 * auth header shape, and the error decoding rules.
 */
export class GraphClient {
    private readonly tokenProvider: TokenProvider;

    constructor(tokenProvider: TokenProvider) {
        this.tokenProvider = tokenProvider;
    }

    /**
     * Fetch one page of the inbox delta stream. Pass `deltaOrNextLink`
     * to follow an existing cursor (next page or next poll cycle), or
     * `null` for the first-ever poll of a mailbox — Graph then starts
     * fresh from "now" with a fresh delta link in the final page.
     *
     * Fields are pinned via `$select` to keep payloads small. The
     * `Prefer: outlook.body-content-type="text"` header makes Graph
     * return plain-text body previews instead of HTML — we don't use
     * the previews to render mail, only to feed the triage prompt.
     */
    async listInboxDelta(userId: string, deltaOrNextLink: string | null): Promise<DeltaPage> {
        const url = deltaOrNextLink ?? this.buildInitialDeltaUrl(userId);
        const response = await this.request("GET", url, {
            preferTokens: ['outlook.body-content-type="text"'],
        });
        const json = (await response.json()) as {
            value?: readonly GraphMailMessage[];
            "@odata.nextLink"?: string;
            "@odata.deltaLink"?: string;
        };
        return {
            value: json.value ?? [],
            nextLink: typeof json["@odata.nextLink"] === "string" ? json["@odata.nextLink"] : null,
            deltaLink:
                typeof json["@odata.deltaLink"] === "string" ? json["@odata.deltaLink"] : null,
        };
    }

    /**
     * Probe a mailbox by asking for its inbox folder id. Used at boot
     * to map whitelisted mailbox addresses to the login that can
     * actually read them. Returns the folder id on success; throws on
     * 4xx (caller treats that as "this login can't reach this
     * mailbox", not a fatal error).
     */
    async probeInbox(userId: string): Promise<string> {
        return this.getWellKnownFolderId(userId, "inbox");
    }

    /**
     * Resolve a Graph well-known mail folder name (`inbox`, `archive`,
     * `deleteditems`, …) to the opaque folder id for one mailbox.
     * Graph's well-known names work as path components in API URLs but
     * never appear in message payloads — `parentFolderId` is always the
     * opaque id. Used by `FolderAliasResolver` to build a reverse map.
     *
     * Returns the opaque id on success. Throws {@link GraphError} on
     * 4xx — most commonly when the mailbox doesn't expose this
     * well-known folder (some tenants don't surface `archive`); the
     * caller treats that as "no mapping for this alias" and proceeds
     * with the other two.
     */
    async getWellKnownFolderId(userId: string, wellKnownName: string): Promise<string> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/mailFolders/${encodeURIComponent(wellKnownName)}?$select=id`;
        const response = await this.request("GET", url);
        const json = (await response.json()) as { id?: string };
        if (typeof json.id !== "string" || json.id.length === 0) {
            throw new GraphError(
                200,
                url,
                `getWellKnownFolderId(${wellKnownName}): response missing \`id\``,
            );
        }
        return json.id;
    }

    /**
     * Fetch just the sender + recipient headers of one message. Used
     * by the core `mail_send_reply` path to gate the original
     * recipients against the send-safety whitelist before dispatching.
     * Returns empty `to` / `cc` arrays when Graph omits the field
     * (rare, but defensive).
     */
    async getMessageRecipients(
        userId: string,
        messageId: string,
    ): Promise<{
        readonly from: string | null;
        readonly to: readonly string[];
        readonly cc: readonly string[];
    }> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}?$select=from,toRecipients,ccRecipients`;
        const response = await this.request("GET", url);
        const json = (await response.json()) as {
            from?: { emailAddress?: { address?: string } } | null;
            toRecipients?: ReadonlyArray<{ emailAddress?: { address?: string } }>;
            ccRecipients?: ReadonlyArray<{ emailAddress?: { address?: string } }>;
        };
        return {
            from:
                typeof json.from?.emailAddress?.address === "string"
                    ? json.from.emailAddress.address
                    : null,
            to: pickAddresses(json.toRecipients),
            cc: pickAddresses(json.ccRecipients),
        };
    }

    /**
     * Search messages in `userId`'s mailbox with a KQL `$search`
     * expression, optionally scoped to a single folder id (Graph alias
     * like `inbox` / `archive` / `deleteditems`). Caller passes a
     * `limit` (the host's remaining global budget) and pagination stops
     * once that many hits have been collected — `$top` is set on each
     * page so Graph doesn't over-fetch.
     *
     * `$search` enables Graph's full-text index on
     * subject/body/from/to/cc with KQL syntax (e.g.
     * `"invoice" AND from:bob@example.com`). Graph rejects combining
     * `$search` with `$orderby`, so hits come back in relevance order;
     * that's the right default for "find mail mentioning X".
     */
    async searchMessages(
        userId: string,
        kql: string,
        folderId: string | null,
        limit: number,
    ): Promise<readonly GraphMailMessage[]> {
        if (limit <= 0) {
            return [];
        }
        const select =
            "id,internetMessageId,from,toRecipients,ccRecipients,subject,receivedDateTime,bodyPreview,hasAttachments,parentFolderId";
        const pageSize = Math.min(limit, 100);
        const path = folderId
            ? `/users/${encodeURIComponent(userId)}/mailFolders/${encodeURIComponent(folderId)}/messages`
            : `/users/${encodeURIComponent(userId)}/messages`;
        const params = new URLSearchParams({
            $search: `"${kql.replace(/"/g, '\\"')}"`,
            $select: select,
            $top: String(pageSize),
        });
        let url: string | null = `${GRAPH_BASE_URL}${path}?${params.toString()}`;
        const out: GraphMailMessage[] = [];
        while (url !== null && out.length < limit) {
            // Graph requires ConsistencyLevel=eventual on $search queries.
            const response = await this.request("GET", url, {
                preferTokens: ['outlook.body-content-type="text"'],
                extraHeaders: { ConsistencyLevel: "eventual" },
            });
            const json = (await response.json()) as {
                value?: readonly GraphMailMessage[];
                "@odata.nextLink"?: string;
            };
            for (const message of json.value ?? []) {
                out.push(message);
                if (out.length >= limit) {
                    break;
                }
            }
            url = typeof json["@odata.nextLink"] === "string" ? json["@odata.nextLink"] : null;
        }
        return out;
    }

    /** Fetch one message's body as plain text. */
    async getMessageBodyText(userId: string, messageId: string): Promise<string> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}?$select=body`;
        const response = await this.request("GET", url, {
            preferTokens: ['outlook.body-content-type="text"'],
        });
        const json = (await response.json()) as {
            body?: { content?: string; contentType?: string };
        };
        return json.body?.content ?? "";
    }

    /**
     * Fetch every non-inline attachment for a message. Inline images
     * are excluded because they live in the body's HTML and aren't
     * user-facing files. The bytes come back base64; caller decodes
     * and stages via `ctx.scratch.addFiles`.
     */
    async getAttachments(userId: string, messageId: string): Promise<readonly GraphAttachment[]> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}/attachments?$filter=isInline eq false`;
        const response = await this.request("GET", url);
        const json = (await response.json()) as { value?: readonly GraphAttachment[] };
        return json.value ?? [];
    }

    /**
     * Create a draft reply / reply-all for an existing message. The
     * rendered HTML goes into Graph's `comment` parameter on the create
     * call — Graph then mints the draft with our comment above the
     * auto-quoted original. Patching `body.content` afterwards would
     * replace the body and wipe the quote, so we deliberately don't.
     */
    async createReplyDraft(
        userId: string,
        messageId: string,
        replyAll: boolean,
        bodyHtml: string,
    ): Promise<{ id: string }> {
        const op = replyAll ? "createReplyAll" : "createReply";
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}/${op}`;
        const created = (await this.request("POST", url, {
            jsonBody: { comment: bodyHtml },
        }).then((r) => r.json())) as { id?: string };
        if (typeof created.id !== "string" || created.id.length === 0) {
            throw new GraphError(200, url, `${op}: response missing draft id`);
        }
        return { id: created.id };
    }

    /**
     * Create a brand-new draft message. Recipients, subject, and body
     * are set in one POST — no follow-up PATCH needed because Graph's
     * `POST /messages` accepts the full draft body inline.
     */
    async createDraft(userId: string, outgoing: GraphOutgoing): Promise<{ id: string }> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/messages`;
        const created = (await this.request("POST", url, {
            jsonBody: this.buildMessageBody(outgoing),
        }).then((r) => r.json())) as { id?: string };
        if (typeof created.id !== "string" || created.id.length === 0) {
            throw new GraphError(200, url, "createDraft: response missing draft id");
        }
        return { id: created.id };
    }

    /**
     * Send a reply / reply-all immediately. Mirrors `sendForward`: the
     * rendered HTML rides in `comment` so Graph auto-quotes the
     * original below it. Passing `message.body.content` here would
     * override the body and lose the quote.
     */
    async sendReply(
        userId: string,
        messageId: string,
        replyAll: boolean,
        bodyHtml: string,
    ): Promise<void> {
        const op = replyAll ? "replyAll" : "reply";
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}/${op}`;
        await this.request("POST", url, {
            jsonBody: { comment: bodyHtml },
        });
    }

    /**
     * Send a brand-new mail. Same shape as `createDraft` but uses
     * Graph's `sendMail` action which composes and dispatches in one
     * request.
     */
    async sendMail(userId: string, outgoing: GraphOutgoing): Promise<void> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/sendMail`;
        await this.request("POST", url, {
            jsonBody: { message: this.buildMessageBody(outgoing), saveToSentItems: true },
        });
    }

    /**
     * Create a draft that forwards an existing message. Comment +
     * recipients go in the create POST (top-level `toRecipients` and
     * `message.ccRecipients`); the draft body is composed by Graph,
     * with the comment above the quoted original and its attachments.
     */
    async createForwardDraft(
        userId: string,
        messageId: string,
        to: readonly GraphRecipient[],
        cc: readonly GraphRecipient[],
        bodyHtml: string,
    ): Promise<{ id: string }> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}/createForward`;
        const created = (await this.request("POST", url, {
            jsonBody: {
                comment: bodyHtml,
                toRecipients: mapGraphRecipients(to),
                message: { ccRecipients: mapGraphRecipients(cc) },
            },
        }).then((r) => r.json())) as { id?: string };
        if (typeof created.id !== "string" || created.id.length === 0) {
            throw new GraphError(200, url, "createForward: response missing draft id");
        }
        return { id: created.id };
    }

    /**
     * Forward an existing message immediately. Graph's `forward` action
     * accepts recipients inline (unlike `createForward`), and the
     * `comment` field is rendered above the quoted original. We pass
     * rendered HTML in `comment` — Outlook renders it correctly there.
     */
    async sendForward(
        userId: string,
        messageId: string,
        to: readonly GraphRecipient[],
        cc: readonly GraphRecipient[],
        commentHtml: string,
    ): Promise<void> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}/forward`;
        await this.request("POST", url, {
            jsonBody: {
                comment: commentHtml,
                toRecipients: mapGraphRecipients(to),
                ccRecipients: mapGraphRecipients(cc),
            },
        });
    }

    /**
     * Move a message to one of the well-known folders Graph exposes.
     * The folder ids come from {@link import("../mail/Folders.js").FOLDER_IDS}.
     */
    async moveMessage(userId: string, messageId: string, folderId: string): Promise<void> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}/move`;
        await this.request("POST", url, { jsonBody: { destinationId: folderId } });
    }

    /**
     * List every calendar the signed-in user can see — both owned and
     * shared. Used by `cal list` and by the calendar poller's startup
     * discovery pass.
     */
    async listCalendars(userId: string): Promise<readonly GraphCalendar[]> {
        const select = "id,name,canEdit,owner,isDefaultCalendar";
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/calendars?$select=${encodeURIComponent(select)}`;
        const response = await this.request("GET", url);
        const json = (await response.json()) as { value?: readonly GraphCalendar[] };
        return json.value ?? [];
    }

    /**
     * Walk the `calendarView/delta` stream for one calendar. On the
     * initial walk pass `deltaOrNextLink: null` and a `window`;
     * subsequent calls follow whatever link the prior page returned
     * (next-page or deltaLink) and the window is ignored — the
     * persisted deltaLink already encodes the window it was minted
     * with. A 410 Gone signals the cursor expired and the caller
     * must restart from a fresh window.
     *
     * @throws if `deltaOrNextLink` is null and `window` is missing.
     */
    async listCalendarViewDelta(
        userId: string,
        calendarId: string,
        deltaOrNextLink: string | null,
        window?: { startDateTime: string; endDateTime: string },
    ): Promise<CalendarDeltaPage> {
        let url: string;
        if (deltaOrNextLink !== null) {
            url = deltaOrNextLink;
        } else {
            if (!window) {
                throw new Error(
                    "listCalendarViewDelta: window required for an initial walk (deltaOrNextLink is null)",
                );
            }
            url = this.buildInitialCalendarDeltaUrl(
                userId,
                calendarId,
                window.startDateTime,
                window.endDateTime,
            );
        }
        const response = await this.request("GET", url, {
            preferTokens: ['outlook.timezone="UTC"'],
        });
        const json = (await response.json()) as {
            value?: readonly GraphCalendarEvent[];
            "@odata.nextLink"?: string;
            "@odata.deltaLink"?: string;
        };
        return {
            value: json.value ?? [],
            nextLink: typeof json["@odata.nextLink"] === "string" ? json["@odata.nextLink"] : null,
            deltaLink:
                typeof json["@odata.deltaLink"] === "string" ? json["@odata.deltaLink"] : null,
        };
    }

    /** Fetch one calendar event by id with the same projection the poller uses. */
    async getCalendarEvent(userId: string, eventId: string): Promise<GraphCalendarEvent> {
        const select = CALENDAR_EVENT_SELECT;
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/events/${encodeURIComponent(eventId)}?$select=${encodeURIComponent(select)}`;
        const response = await this.request("GET", url, {
            preferTokens: ['outlook.timezone="UTC"', 'outlook.body-content-type="text"'],
        });
        return (await response.json()) as GraphCalendarEvent;
    }

    /**
     * Create a fresh event on a calendar. Returns the created event in
     * the same projection the poller would persist, so the caller can
     * upsert it without a follow-up GET.
     */
    async createCalendarEvent(
        userId: string,
        calendarId: string,
        body: GraphCalendarEventCreate,
    ): Promise<GraphCalendarEvent> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/calendars/${encodeURIComponent(calendarId)}/events`;
        const response = await this.request("POST", url, {
            jsonBody: body,
            preferTokens: ['outlook.timezone="UTC"'],
        });
        return (await response.json()) as GraphCalendarEvent;
    }

    /**
     * Apply a partial update to an existing event. Graph treats the
     * body as a sparse patch — only fields present here are mutated;
     * everything else stays as it was. Returns the post-patch event
     * in the same projection the poller / create path uses.
     */
    async updateCalendarEvent(
        userId: string,
        eventId: string,
        body: Partial<GraphCalendarEventCreate>,
    ): Promise<GraphCalendarEvent> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/events/${encodeURIComponent(eventId)}`;
        const response = await this.request("PATCH", url, {
            jsonBody: body,
            preferTokens: ['outlook.timezone="UTC"'],
        });
        return (await response.json()) as GraphCalendarEvent;
    }

    /** Delete an event by id. Idempotent: 404 still propagates as `GraphError`. */
    async deleteCalendarEvent(userId: string, eventId: string): Promise<void> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/events/${encodeURIComponent(eventId)}`;
        await this.request("DELETE", url);
    }

    /**
     * Inline-attach a file (≤3MB) to an event. Larger uploads require
     * a `createUploadSession` flow that is out of scope for v1.
     */
    async addEventAttachment(
        userId: string,
        eventId: string,
        name: string,
        contents: Buffer,
        contentType = "application/octet-stream",
    ): Promise<void> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/events/${encodeURIComponent(eventId)}/attachments`;
        await this.request("POST", url, {
            jsonBody: {
                "@odata.type": "#microsoft.graph.fileAttachment",
                name,
                contentType,
                contentBytes: contents.toString("base64"),
            },
        });
    }

    /** Fetch every attachment for an event. Bytes come back base64. */
    async getEventAttachments(
        userId: string,
        eventId: string,
    ): Promise<readonly GraphAttachment[]> {
        const url = `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/events/${encodeURIComponent(eventId)}/attachments`;
        const response = await this.request("GET", url);
        const json = (await response.json()) as { value?: readonly GraphAttachment[] };
        return json.value ?? [];
    }

    private buildInitialCalendarDeltaUrl(
        userId: string,
        calendarId: string,
        startDateTime: string,
        endDateTime: string,
    ): string {
        const select = CALENDAR_EVENT_SELECT;
        const params = new URLSearchParams({
            startDateTime,
            endDateTime,
            $select: select,
        });
        return `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?${params.toString()}`;
    }

    private buildInitialDeltaUrl(userId: string): string {
        const select =
            "id,internetMessageId,from,toRecipients,ccRecipients,subject,receivedDateTime,bodyPreview,hasAttachments,parentFolderId";
        return `${GRAPH_BASE_URL}/users/${encodeURIComponent(userId)}/mailFolders/inbox/messages/delta?$select=${encodeURIComponent(select)}`;
    }

    private buildMessageBody(outgoing: GraphOutgoing): Record<string, unknown> {
        return {
            subject: outgoing.subject,
            body: { contentType: "HTML", content: outgoing.bodyHtml },
            toRecipients: mapGraphRecipients(outgoing.to),
            ccRecipients: mapGraphRecipients(outgoing.cc ?? []),
            isDraft: true,
        };
    }

    private async request(
        method: string,
        url: string,
        options?: {
            jsonBody?: unknown;
            preferTokens?: readonly string[];
            extraHeaders?: Record<string, string>;
        },
    ): Promise<Response> {
        const token = await this.tokenProvider();
        const preferTokens = [IMMUTABLE_ID_PREFER, ...(options?.preferTokens ?? [])];
        const headers: Record<string, string> = {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            Prefer: preferTokens.join(", "),
            ...(options?.extraHeaders ?? {}),
        };
        let body: string | undefined;
        if (options?.jsonBody !== undefined) {
            headers["Content-Type"] = "application/json";
            body = JSON.stringify(options.jsonBody);
        }
        const response = await fetch(url, { method, headers, body });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new GraphError(response.status, url, text);
        }
        return response;
    }
}
