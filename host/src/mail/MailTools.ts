import {
    buildMailId,
    type EventRow,
    type ForwardInput,
    type MailFolder,
    type MailProvider,
    type MailSearchHit,
    type NewMailInput,
    type PluginTool,
    parseMailId,
    type ReplyInput,
    runTool,
    type ToolFailure,
} from "@getfamiliar/shared";
import { DateTime } from "luxon";
import { readCoreTimezone } from "../calendar/EventRenderer.js";
import type { MailRegistry } from "./MailRegistry.js";
import type { MailSafety } from "./MailSafety.js";

/** Global hard cap on hits returned per `mail_search` call. */
const MAIL_SEARCH_LIMIT = 100;

/** Default hit count when the agent doesn't pass `limit` explicitly. */
const MAIL_SEARCH_DEFAULT_LIMIT = 10;

/**
 * Build the plugin-agnostic `mail_*` agent tools. They run host-side
 * and dispatch to whichever {@link MailProvider} owns the target mail
 * (parsed from the `<pluginId>:<mailbox>:<realId>` prefix on every
 * mail id).
 *
 * Conventions every tool shares:
 *
 *   - **`mail_id` resolution.** Agents may omit `mail_id`; in that
 *     case the tool falls back to `event.payload.mail_id` of the
 *     originating mail event. This keeps mail handlers terse while
 *     letting chat-initiated calls reference any mail by id.
 *   - **Provider error pass-through.** When the chosen provider
 *     exposes an `adaptError` mapper, its `{status, code, message}`
 *     envelope flows back to the agent (e.g. Graph's
 *     `ErrorItemNotFound`). Non-provider throws collapse to the
 *     generic `ToolError` arm.
 *   - **Result id wrapping.** Every id returned by a provider is
 *     wrapped with `<pluginId>:<mailbox>:` before being handed back —
 *     so a draft id from `mail_draft_reply` is immediately usable as
 *     the input to a follow-up `mail_send_*` or `mail_move`.
 */
export function buildMailTools(deps: MailToolsDeps): readonly PluginTool[] {
    return [
        fetchBodyTool(deps),
        fetchAttachmentsTool(deps),
        searchTool(deps),
        draftReplyTool(deps),
        draftForwardTool(deps),
        draftNewTool(deps),
        sendReplyTool(deps),
        sendForwardTool(deps),
        sendNewTool(deps),
        moveTool(deps),
    ];
}

export interface MailToolsDeps {
    readonly registry: MailRegistry;
    readonly safety: MailSafety;
}

/** Resolved (provider, mailbox, realId) for one tool invocation. */
interface MailTarget {
    readonly provider: MailProvider;
    readonly pluginId: string;
    readonly mailbox: string;
    readonly realId: string;
}

interface MailIdArgs {
    readonly mail_id?: string;
}

interface FetchBodyResult {
    readonly body: string;
}

function fetchBodyTool(
    deps: MailToolsDeps,
): PluginTool<MailIdArgs, ({ ok: true } & FetchBodyResult) | ToolFailure> {
    return {
        name: "mail_fetch_body",
        description:
            "Fetch the full plain-text body of one mail. `mail_id` is " +
            "the `<plugin>:<mailbox>:<id>` prefixed id; omit to use the " +
            "current mail event's id when the handler is reacting to a " +
            "mail. Returns the body verbatim — use this when the event " +
            "payload's body preview was truncated.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                mail_id: {
                    type: "string",
                    description: "Prefixed mail id; defaults to the current mail event's id.",
                },
            },
        },
        execute: (args, callCtx) => {
            const target = tryResolveTarget(args.mail_id, callCtx.event, deps.registry);
            return runTool(async () => {
                const body = await target.provider.fetchBody(target.mailbox, target.realId);
                return { body };
            }, target.provider.adaptError);
        },
    };
}

interface FetchAttachmentsResult {
    readonly paths: readonly string[];
}

function fetchAttachmentsTool(
    deps: MailToolsDeps,
): PluginTool<MailIdArgs, ({ ok: true } & FetchAttachmentsResult) | ToolFailure> {
    return {
        name: "mail_fetch_attachments",
        description:
            "Download every non-inline attachment of one mail into this " +
            "agentrun's scratch directory. Returns the absolute paths " +
            "(under `/scratch/<event-id>/`). `mail_id` is the prefixed " +
            "mail id; omit to use the current mail event's id.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                mail_id: { type: "string" },
            },
        },
        execute: (args, callCtx) => {
            const target = tryResolveTarget(args.mail_id, callCtx.event, deps.registry);
            return runTool(async () => {
                const attachments = await target.provider.fetchAttachments(
                    target.mailbox,
                    target.realId,
                );
                if (attachments.length === 0) {
                    return { paths: [] as readonly string[] };
                }
                const used = new Set<string>();
                const files = attachments.map((att) => ({
                    name: dedupName(att.name, used),
                    contents: att.contents,
                }));
                const paths = await callCtx.host.scratch.addFiles(callCtx.event.id, files);
                return { paths };
            }, target.provider.adaptError);
        },
    };
}

interface SearchArgs {
    readonly text?: string;
    readonly contact?: string;
    readonly before?: string;
    readonly after?: string;
    readonly folder?: string;
    readonly plugin?: string;
    readonly mailbox?: string;
    readonly limit?: number;
}

interface SearchResult {
    /**
     * Newline-delimited JSON. Each line is one `mail:new`-shaped
     * payload (mail_id, isShared, from, to, cc, subject, date,
     * internetMessageId, hasAttachments, attachments). Empty string
     * when nothing matched.
     */
    readonly jsonl: string;
    /**
     * `true` when the global 100-hit cap was reached and additional
     * matches were dropped. The agent should narrow the query (tighter
     * date window, more specific text, named contact) when this is
     * set and completeness matters.
     */
    readonly truncated: boolean;
}

/**
 * Build the plugin-agnostic `mail_search` tool. Routes through every
 * registered {@link MailProvider} (or just one, when `plugin` pins it)
 * and merges hits into a single JSONL response. Output shape matches
 * the `mail:new` event payload so handlers can react to live mail and
 * search hits with the same downstream logic.
 *
 * Date predicates are resolved against `core.timezone` (Luxon — same
 * convention as `cal_get_events`): `after` becomes the start-of-day
 * for that local day in UTC, `before` becomes the start of the **next**
 * local day (so the upper bound is inclusive on the user-facing
 * `YYYY-MM-DD`). Agents may also pass wall-clock
 * `YYYY-MM-DDTHH:mm:ss`; the same `core.timezone` interprets it.
 *
 * The agent's `limit` (default 10, clamped to the hard ceiling of 100)
 * is enforced as a global budget, decremented across providers — once
 * earlier providers fill the cap, later providers aren't called at all.
 */
function searchTool(
    deps: MailToolsDeps,
): PluginTool<SearchArgs, ({ ok: true } & SearchResult) | ToolFailure> {
    return {
        name: "mail_search",
        description:
            "Search mail across every registered provider. Predicates: `text` " +
            "(full-text over subject/body/from/to/cc; KQL keywords like " +
            "`hasAttachments:true` work too); `contact` (matches sender, To, or " +
            "Cc — single address); `after` / `before` (YYYY-MM-DD or " +
            "YYYY-MM-DDTHH:mm:ss in your `core.timezone`, inclusive bounds at " +
            "day resolution); `folder` (inbox|archive|trash); `plugin` (e.g. " +
            "`ms365`) to pin one provider; `mailbox` to pin one address (works " +
            "even for unpolled mailboxes a login can reach); `limit` to cap " +
            "the number of hits (defaults to 10, hard maximum 100). Returns up to that many " +
            "hits as JSONL — one `mail:new`-shaped object per line. Set " +
            "`truncated` indicates the cap was hit; raise `limit` or narrow " +
            "the query if completeness matters. Hit ids are self-routing — pass any " +
            "`mail_id` straight to `mail_fetch_body`, `mail_draft_reply`, etc.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                text: { type: "string", description: "Full-text query (KQL)." },
                contact: {
                    type: "string",
                    description: "Email address that must appear as sender, To, or Cc.",
                },
                after: {
                    type: "string",
                    description:
                        "Inclusive lower bound in your `core.timezone` " +
                        "(YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss).",
                },
                before: {
                    type: "string",
                    description:
                        "Inclusive upper bound in your `core.timezone` " +
                        "(YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss).",
                },
                folder: { type: "string", enum: ["inbox", "archive", "trash"] },
                plugin: {
                    type: "string",
                    description: "Restrict the search to one registered provider (e.g. 'ms365').",
                },
                mailbox: {
                    type: "string",
                    description:
                        "Restrict the search to one mailbox address. Works for " +
                        "unpolled mailboxes that a login can reach.",
                },
                limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: MAIL_SEARCH_LIMIT,
                    description: `Maximum number of hits to return. Defaults to ${MAIL_SEARCH_DEFAULT_LIMIT}; hard maximum is ${MAIL_SEARCH_LIMIT} (values above are clamped).`,
                },
            },
        },
        execute: (args, callCtx) => {
            return runTool(async () => {
                const coreTz = readCoreTimezone(callCtx.host.config);
                const { after, before } = resolveSearchDateBounds(args, coreTz);
                if (
                    !args.text &&
                    !args.contact &&
                    after === undefined &&
                    before === undefined &&
                    !args.folder
                ) {
                    throw new Error(
                        "mail_search requires at least one of `text`, `contact`, `after`, " +
                            "`before`, `folder` — an unconstrained search would return every " +
                            "mail in the mailbox.",
                    );
                }
                if (args.folder !== undefined && !isMailFolder(args.folder)) {
                    throw new Error(
                        `folder must be one of inbox|archive|trash, got: ${args.folder}`,
                    );
                }
                const cap = resolveSearchLimit(args.limit);
                const providers = pickSearchProviders(deps.registry, args.plugin);
                const hits: MailSearchHit[] = [];
                let truncated = false;
                for (const provider of providers) {
                    const remaining = cap - hits.length;
                    if (remaining <= 0) {
                        truncated = true;
                        break;
                    }
                    const providerHits = await provider.search({
                        text: args.text,
                        contact: args.contact,
                        after,
                        before,
                        folder: args.folder as MailFolder | undefined,
                        mailbox: args.mailbox,
                        limit: remaining,
                    });
                    for (const hit of providerHits) {
                        if (hits.length >= cap) {
                            truncated = true;
                            break;
                        }
                        hits.push(hit);
                    }
                    // Provider may have hit its own ceiling at exactly the
                    // remaining budget; surface as truncated so the agent
                    // knows there might be more.
                    if (providerHits.length >= remaining && hits.length >= cap) {
                        truncated = true;
                    }
                }
                return {
                    jsonl: hits.map((h) => JSON.stringify(h)).join("\n"),
                    truncated,
                };
            });
        },
    };
}

/**
 * Resolve `after` / `before` from agent-supplied local-tz strings to
 * UTC ISO instants. Both bounds are inclusive at day resolution:
 * `after=2026-05-01` means "on or after the start of May 1 local time",
 * `before=2026-05-31` means "strictly before the start of June 1 local
 * time" — so both ends of the day are included.
 *
 * Accepts either bare `YYYY-MM-DD` (treated as start-of-day) or full
 * wall-clock `YYYY-MM-DDTHH:mm:ss` (used verbatim, no day rounding) so
 * the agent can ask for narrow time windows when needed. Invalid input
 * throws with an agent-readable message — the tool surfaces this as a
 * `ToolFailure` before any provider call.
 */
/**
 * Resolve the agent-supplied `limit` to the per-call cap. Missing
 * falls back to {@link MAIL_SEARCH_DEFAULT_LIMIT}; anything above the
 * hard {@link MAIL_SEARCH_LIMIT} ceiling is clamped down. Non-positive
 * and non-finite values throw so the agent gets a clear failure rather
 * than a silent empty result.
 */
function resolveSearchLimit(raw: number | undefined): number {
    if (raw === undefined) {
        return MAIL_SEARCH_DEFAULT_LIMIT;
    }
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
        throw new Error(`limit must be a positive integer, got: ${raw}`);
    }
    return Math.min(raw, MAIL_SEARCH_LIMIT);
}

function resolveSearchDateBounds(
    args: SearchArgs,
    coreTz: string,
): { after: string | undefined; before: string | undefined } {
    return {
        after: args.after !== undefined ? toLowerBound(args.after, coreTz) : undefined,
        before: args.before !== undefined ? toUpperBound(args.before, coreTz) : undefined,
    };
}

function toLowerBound(value: string, coreTz: string): string {
    const dt = DateTime.fromISO(value, { zone: coreTz });
    if (!dt.isValid) {
        throw new Error(
            `after "${value}" is not a valid date — use YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss`,
        );
    }
    const lower = isDateOnly(value) ? dt.startOf("day") : dt;
    const iso = lower.toUTC().toISO({ suppressMilliseconds: true });
    if (iso === null) {
        throw new Error(`after "${value}" could not be converted to UTC`);
    }
    return iso;
}

function toUpperBound(value: string, coreTz: string): string {
    const dt = DateTime.fromISO(value, { zone: coreTz });
    if (!dt.isValid) {
        throw new Error(
            `before "${value}" is not a valid date — use YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss`,
        );
    }
    const upper = isDateOnly(value) ? dt.startOf("day").plus({ days: 1 }) : dt;
    const iso = upper.toUTC().toISO({ suppressMilliseconds: true });
    if (iso === null) {
        throw new Error(`before "${value}" could not be converted to UTC`);
    }
    return iso;
}

/** True for bare `YYYY-MM-DD`; false when the input also carries a time. */
function isDateOnly(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function pickSearchProviders(
    registry: MailRegistry,
    pluginFilter: string | undefined,
): readonly MailProvider[] {
    if (typeof pluginFilter === "string" && pluginFilter.length > 0) {
        return [registry.forPluginId(pluginFilter)];
    }
    return registry.all();
}

interface DraftReplyArgs extends MailIdArgs {
    readonly body: string;
    readonly replyAll?: boolean;
}

interface DraftResult {
    readonly drafted: true;
    readonly draftId: string;
}

function draftReplyTool(
    deps: MailToolsDeps,
): PluginTool<DraftReplyArgs, ({ ok: true } & DraftResult) | ToolFailure> {
    return {
        name: "mail_draft_reply",
        description:
            "Create a draft reply to one mail. `body` is markdown; the " +
            "provider renders it as HTML. Set `replyAll` to true to " +
            "address every original recipient including CCs. Returns " +
            "the prefixed id of the created draft.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["body"],
            properties: {
                mail_id: { type: "string" },
                body: { type: "string", description: "Markdown body of the reply." },
                replyAll: { type: "boolean" },
            },
        },
        execute: (args, callCtx) => {
            const target = tryResolveTarget(args.mail_id, callCtx.event, deps.registry);
            const input: ReplyInput = {
                bodyMarkdown: args.body,
                replyAll: args.replyAll === true,
            };
            return runTool(async () => {
                const draftRealId = await target.provider.draftReply(
                    target.mailbox,
                    target.realId,
                    input,
                );
                return {
                    drafted: true as const,
                    draftId: buildMailId(target.pluginId, target.mailbox, draftRealId),
                };
            }, target.provider.adaptError);
        },
    };
}

interface DraftForwardArgs extends MailIdArgs {
    readonly to: readonly string[];
    readonly cc?: readonly string[];
    readonly comment?: string;
}

function draftForwardTool(
    deps: MailToolsDeps,
): PluginTool<DraftForwardArgs, ({ ok: true } & DraftResult) | ToolFailure> {
    return {
        name: "mail_draft_forward",
        description:
            "Create a draft forwarding one mail to new recipients. " +
            "`comment` is optional markdown that lands above the quoted " +
            "original. The provider carries over the original " +
            "attachments. Returns the prefixed id of the created draft.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["to"],
            properties: {
                mail_id: { type: "string" },
                to: { type: "array", items: { type: "string" } },
                cc: { type: "array", items: { type: "string" } },
                comment: { type: "string" },
            },
        },
        execute: (args, callCtx) => {
            const target = tryResolveTarget(args.mail_id, callCtx.event, deps.registry);
            const input: ForwardInput = {
                to: args.to,
                cc: args.cc ?? [],
                commentMarkdown: args.comment ?? "",
            };
            return runTool(async () => {
                const draftRealId = await target.provider.draftForward(
                    target.mailbox,
                    target.realId,
                    input,
                );
                return {
                    drafted: true as const,
                    draftId: buildMailId(target.pluginId, target.mailbox, draftRealId),
                };
            }, target.provider.adaptError);
        },
    };
}

interface DraftNewArgs {
    readonly from?: string;
    readonly to: readonly string[];
    readonly cc?: readonly string[];
    readonly subject: string;
    readonly body: string;
}

function draftNewTool(
    deps: MailToolsDeps,
): PluginTool<DraftNewArgs, ({ ok: true } & DraftResult) | ToolFailure> {
    return {
        name: "mail_draft_new",
        description:
            "Create a brand-new draft mail. `from` is the sending " +
            "mailbox in `<plugin>:<mailbox>` form (e.g. " +
            "`ms365:user@example.com`); omit to use the current mail " +
            "event's mailbox. `body` is markdown. Returns the prefixed " +
            "id of the created draft.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["to", "subject", "body"],
            properties: {
                from: {
                    type: "string",
                    description:
                        "Sender in '<plugin>:<mailbox>' form; defaults to the current mail event's mailbox.",
                },
                to: { type: "array", items: { type: "string" } },
                cc: { type: "array", items: { type: "string" } },
                subject: { type: "string" },
                body: { type: "string", description: "Markdown body of the mail." },
            },
        },
        execute: (args, callCtx) => {
            const sender = resolveSender(args.from, callCtx.event, deps.registry);
            const input: NewMailInput = {
                to: args.to,
                cc: args.cc ?? [],
                subject: args.subject,
                bodyMarkdown: args.body,
            };
            return runTool(async () => {
                const draftRealId = await sender.provider.draftNew(sender.mailbox, input);
                return {
                    drafted: true as const,
                    draftId: buildMailId(sender.pluginId, sender.mailbox, draftRealId),
                };
            }, sender.provider.adaptError);
        },
    };
}

interface SendResult {
    readonly sent: boolean;
    readonly draftId?: string;
    readonly reason?: string;
}

function sendReplyTool(
    deps: MailToolsDeps,
): PluginTool<DraftReplyArgs, ({ ok: true } & SendResult) | ToolFailure> {
    return {
        name: "mail_send_reply",
        description:
            "Send a reply immediately. When `mail.allowSend` is false " +
            "or any recipient is outside `mail.recipientWhitelist`, " +
            "the tool transparently creates a draft instead and reports " +
            "the reason. `body` is markdown; set `replyAll` to reply " +
            "to every original recipient.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["body"],
            properties: {
                mail_id: { type: "string" },
                body: { type: "string" },
                replyAll: { type: "boolean" },
            },
        },
        execute: (args, callCtx) => {
            const target = tryResolveTarget(args.mail_id, callCtx.event, deps.registry);
            const replyAll = args.replyAll === true;
            const input: ReplyInput = { bodyMarkdown: args.body, replyAll };
            return runTool<SendResult>(async () => {
                const recipients = await target.provider.previewReplyRecipients(
                    target.mailbox,
                    target.realId,
                    replyAll,
                );
                const decision = deps.safety.checkSendAllowed(recipients);
                if (!decision.send) {
                    const draftRealId = await target.provider.draftReply(
                        target.mailbox,
                        target.realId,
                        input,
                    );
                    return {
                        sent: false,
                        draftId: buildMailId(target.pluginId, target.mailbox, draftRealId),
                        reason: decision.reason,
                    };
                }
                await target.provider.sendReply(target.mailbox, target.realId, input);
                return { sent: true };
            }, target.provider.adaptError);
        },
    };
}

function sendForwardTool(
    deps: MailToolsDeps,
): PluginTool<DraftForwardArgs, ({ ok: true } & SendResult) | ToolFailure> {
    return {
        name: "mail_send_forward",
        description:
            "Forward one mail immediately. When `mail.allowSend` is " +
            "false or any recipient is outside the whitelist, the tool " +
            "transparently creates a draft instead and reports the " +
            "reason. The provider carries over the original attachments.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["to"],
            properties: {
                mail_id: { type: "string" },
                to: { type: "array", items: { type: "string" } },
                cc: { type: "array", items: { type: "string" } },
                comment: { type: "string" },
            },
        },
        execute: (args, callCtx) => {
            const target = tryResolveTarget(args.mail_id, callCtx.event, deps.registry);
            const input: ForwardInput = {
                to: args.to,
                cc: args.cc ?? [],
                commentMarkdown: args.comment ?? "",
            };
            const recipients = [...input.to, ...input.cc];
            return runTool<SendResult>(async () => {
                const decision = deps.safety.checkSendAllowed(recipients);
                if (!decision.send) {
                    const draftRealId = await target.provider.draftForward(
                        target.mailbox,
                        target.realId,
                        input,
                    );
                    return {
                        sent: false,
                        draftId: buildMailId(target.pluginId, target.mailbox, draftRealId),
                        reason: decision.reason,
                    };
                }
                await target.provider.sendForward(target.mailbox, target.realId, input);
                return { sent: true };
            }, target.provider.adaptError);
        },
    };
}

function sendNewTool(
    deps: MailToolsDeps,
): PluginTool<DraftNewArgs, ({ ok: true } & SendResult) | ToolFailure> {
    return {
        name: "mail_send_new",
        description:
            "Send a brand-new mail immediately. When `mail.allowSend` " +
            "is false or any recipient is outside the whitelist, the " +
            "tool transparently creates a draft instead and reports " +
            "the reason. `from` is the sending mailbox in " +
            "`<plugin>:<mailbox>` form; omit to use the current mail " +
            "event's mailbox.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["to", "subject", "body"],
            properties: {
                from: { type: "string" },
                to: { type: "array", items: { type: "string" } },
                cc: { type: "array", items: { type: "string" } },
                subject: { type: "string" },
                body: { type: "string" },
            },
        },
        execute: (args, callCtx) => {
            const sender = resolveSender(args.from, callCtx.event, deps.registry);
            const input: NewMailInput = {
                to: args.to,
                cc: args.cc ?? [],
                subject: args.subject,
                bodyMarkdown: args.body,
            };
            const recipients = [...input.to, ...input.cc];
            return runTool<SendResult>(async () => {
                const decision = deps.safety.checkSendAllowed(recipients);
                if (!decision.send) {
                    const draftRealId = await sender.provider.draftNew(sender.mailbox, input);
                    return {
                        sent: false,
                        draftId: buildMailId(sender.pluginId, sender.mailbox, draftRealId),
                        reason: decision.reason,
                    };
                }
                await sender.provider.sendNew(sender.mailbox, input);
                return { sent: true };
            }, sender.provider.adaptError);
        },
    };
}

interface MoveArgs extends MailIdArgs {
    readonly folder: MailFolder;
}

function moveTool(
    deps: MailToolsDeps,
): PluginTool<MoveArgs, { ok: true; moved: true; folder: MailFolder } | ToolFailure> {
    return {
        name: "mail_move",
        description:
            "Move one mail to a folder. Allowed folders: `inbox`, " +
            "`archive`, `trash`. `mail_id` is the prefixed id; omit to " +
            "use the current mail event's id.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["folder"],
            properties: {
                mail_id: { type: "string" },
                folder: { type: "string", enum: ["inbox", "archive", "trash"] },
            },
        },
        execute: (args, callCtx) => {
            const target = tryResolveTarget(args.mail_id, callCtx.event, deps.registry);
            return runTool(async () => {
                if (!isMailFolder(args.folder)) {
                    throw new Error(
                        `folder must be one of inbox|archive|trash, got: ${args.folder}`,
                    );
                }
                await target.provider.move(target.mailbox, target.realId, args.folder);
                return { moved: true as const, folder: args.folder };
            }, target.provider.adaptError);
        },
    };
}

/**
 * Resolve a mail id (explicit arg or event-payload fallback) and look
 * up the provider that owns its `<pluginId>:` prefix. Throws a clear,
 * agent-readable error when neither source yields a usable id — the
 * agent then learns to pass `mail_id` explicitly.
 */
function tryResolveTarget(
    explicit: string | undefined,
    event: EventRow,
    registry: MailRegistry,
): MailTarget {
    const id = pickMailId(explicit, event);
    const parsed = parseMailId(id);
    const provider = registry.forPluginId(parsed.pluginId);
    return {
        provider,
        pluginId: parsed.pluginId,
        mailbox: parsed.mailbox,
        realId: parsed.realId,
    };
}

function pickMailId(explicit: string | undefined, event: EventRow): string {
    if (typeof explicit === "string" && explicit.length > 0) {
        return explicit;
    }
    const fallback = readPayloadMailId(event);
    if (fallback) {
        return fallback;
    }
    throw new Error(
        "no mail_id given and event.payload.mail_id is missing — pass mail_id explicitly when " +
            "calling a mail tool from a non-mail handler.",
    );
}

function readPayloadMailId(event: EventRow): string | null {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") {
        return null;
    }
    const value = (payload as Record<string, unknown>).mail_id;
    return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolved (provider, mailbox) for `mail_draft_new` / `mail_send_new`.
 * The "from" argument is `<pluginId>:<mailbox>` — same prefix
 * convention as a mail id minus the real id segment. Falls back to
 * the current event's mail-id prefix when omitted.
 */
interface MailSender {
    readonly provider: MailProvider;
    readonly pluginId: string;
    readonly mailbox: string;
}

function resolveSender(
    explicit: string | undefined,
    event: EventRow,
    registry: MailRegistry,
): MailSender {
    if (typeof explicit === "string" && explicit.length > 0) {
        const colon = explicit.indexOf(":");
        if (colon <= 0 || colon === explicit.length - 1) {
            throw new Error(
                `from "${explicit}" is malformed — expected "<plugin>:<mailbox>" ` +
                    "(e.g. ms365:user@example.com)",
            );
        }
        const pluginId = explicit.slice(0, colon);
        const mailbox = explicit.slice(colon + 1);
        if (mailbox.includes(":")) {
            throw new Error(`from "${explicit}" mailbox segment must not contain ":"`);
        }
        return { provider: registry.forPluginId(pluginId), pluginId, mailbox };
    }
    const fallbackId = readPayloadMailId(event);
    if (!fallbackId) {
        throw new Error(
            "no `from` given and event.payload.mail_id is missing — pass `from` explicitly " +
                "(e.g. ms365:user@example.com) when composing from a non-mail handler.",
        );
    }
    const parsed = parseMailId(fallbackId);
    return {
        provider: registry.forPluginId(parsed.pluginId),
        pluginId: parsed.pluginId,
        mailbox: parsed.mailbox,
    };
}

function isMailFolder(value: unknown): value is MailFolder {
    return value === "inbox" || value === "archive" || value === "trash";
}

/**
 * Pick a basename safe to write under `/scratch/<event-id>/`, disambiguating
 * against names already used in this tool call. Mirrors the helper in
 * `CalendarTools` so a multi-attachment fetch never overwrites itself.
 */
function dedupName(name: string, used: Set<string>): string {
    const cleaned = name.replace(/[/\\]/g, "_").replace(/^\.+/, "");
    let candidate = cleaned.length > 0 ? cleaned : "attachment";
    if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
    }
    const dot = candidate.lastIndexOf(".");
    const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
    const ext = dot > 0 ? candidate.slice(dot) : "";
    for (let i = 2; i < 1000; i++) {
        candidate = `${stem} (${i})${ext}`;
        if (!used.has(candidate)) {
            used.add(candidate);
            return candidate;
        }
    }
    throw new Error("could not dedupe attachment name");
}
