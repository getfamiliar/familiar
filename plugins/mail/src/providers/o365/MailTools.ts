import type { EventRow, PluginTool, PluginToolCallContext } from "@getfamiliar/shared";
import { readO365Config } from "../../Config.js";
import { FOLDER_IDS, type FolderAlias, isFolderAlias } from "./Folders.js";
import { GraphClient, GraphError, type GraphRecipient } from "./GraphClient.js";
import { renderMailHtml } from "./MailHtml.js";
import type { O365Provider } from "./O365Provider.js";

/**
 * Structured failure envelope returned to the agent when a Graph call
 * errors. Keeping the shape uniform across every tool means the agent
 * never has to parse free text — a single `ok: false` arm carries the
 * Graph status code, the Graph error code (`ErrorItemNotFound`, …),
 * and the human-readable message. Non-Graph exceptions (programming
 * bugs, missing logins) still surface as `{ok:false, error:{...}}`
 * with `status: 0` and `code: "ToolError"` so the agent's parsing
 * code can stay shape-stable.
 */
export interface ToolFailure {
    readonly ok: false;
    readonly error: {
        readonly status: number;
        readonly code: string;
        readonly message: string;
    };
}

/**
 * Run a tool body and normalise its return shape. Success bodies are
 * augmented with `ok: true`; `GraphError` becomes a `ToolFailure`
 * carrying Graph's own status and code; any other throw becomes a
 * generic `ToolFailure` with `status: 0`. The agent's tool-call decoder
 * always sees one of two shapes.
 */
async function runTool<TResult extends object>(
    body: () => Promise<TResult>,
): Promise<({ ok: true } & TResult) | ToolFailure> {
    try {
        const result = await body();
        return { ok: true, ...result };
    } catch (err) {
        if (err instanceof GraphError) {
            return {
                ok: false,
                error: {
                    status: err.status,
                    code: err.code ?? "GraphError",
                    message: err.graphMessage,
                },
            };
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            error: { status: 0, code: "ToolError", message },
        };
    }
}

/**
 * Build the six agent-facing mail tools the o365 provider contributes.
 * Each tool resolves its mail-event context from the originating
 * `EventRow.payload` — the agent never passes message ids or mailbox
 * addresses; it can only ever act on the mail the current agentrun is
 * reacting to.
 *
 * The provider reference is captured at construction time so the
 * tools share its `LoginStore` and stay coherent with the daemon's
 * mailbox map.
 */
export function buildMailTools(provider: O365Provider): readonly PluginTool[] {
    return [
        fetchBodyTool(provider),
        fetchAttachmentsTool(provider),
        draftReplyTool(provider),
        draftNewTool(provider),
        sendReplyTool(provider),
        sendNewTool(provider),
        draftForwardTool(provider),
        sendForwardTool(provider),
        moveTool(provider),
    ];
}

/** Common per-tool context resolved from the event payload. */
interface MailEventContext {
    readonly upn: string;
    readonly mailbox: string;
    readonly messageId: string;
    readonly client: GraphClient;
}

/**
 * Pull the (`upn`, `mailbox`, `messageId`) tuple the o365 emitter
 * stamped on every `mail:o365` event, look up the matching `GraphAuth`
 * in the provider's `LoginStore`, and assemble a Graph client bound
 * to that login. Throws a clear error if any piece is missing — the
 * agent's tool-call surface should never get past these checks unless
 * the event was genuinely produced by the o365 plugin.
 */
function resolveMailEvent(
    provider: O365Provider,
    event: EventRow,
    host: PluginToolCallContext["host"],
): MailEventContext {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") {
        throw new Error("event.payload is missing — mail tools require a mail:o365 event");
    }
    const upn = readPayloadString(payload, "upn");
    const mailbox = readPayloadString(payload, "mailbox");
    const messageId = readPayloadString(payload, "messageId");
    const store = provider.getLoginStore(host);
    const auth = store.byUpn(upn);
    if (!auth) {
        throw new Error(
            `no active o365 login for ${upn}; run \`./cli.sh mail o365 login\` to add one`,
        );
    }
    const client = new GraphClient(() => auth.getAccessTokenSilent());
    return { upn, mailbox, messageId, client };
}

function readPayloadString(payload: object, key: string): string {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`event.payload.${key} is missing or not a string`);
    }
    return value;
}

function fetchBodyTool(
    provider: O365Provider,
): PluginTool<Record<string, never>, { ok: true; body: string } | ToolFailure> {
    return {
        name: "fetch_body",
        description:
            "Fetch the full plain-text body of the mail this agentrun is reacting to. " +
            "Use when the body preview in the event payload is truncated. No arguments.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        execute: (_args, callCtx) =>
            runTool(async () => {
                const { client, mailbox, messageId } = resolveMailEvent(
                    provider,
                    callCtx.event,
                    callCtx.host,
                );
                const body = await client.getMessageBodyText(mailbox, messageId);
                return { body };
            }),
    };
}

function fetchAttachmentsTool(
    provider: O365Provider,
): PluginTool<Record<string, never>, { ok: true; paths: readonly string[] } | ToolFailure> {
    return {
        name: "fetch_attachments",
        description:
            "Download every non-inline attachment of the current mail into this agentrun's " +
            "scratch directory. Returns the absolute paths (under /scratch/<event-id>/). " +
            "No arguments.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        execute: (_args, callCtx) =>
            runTool(async () => {
                const { client, mailbox, messageId } = resolveMailEvent(
                    provider,
                    callCtx.event,
                    callCtx.host,
                );
                const attachments = await client.getAttachments(mailbox, messageId);
                const files = attachments
                    .filter((a) => typeof a.contentBytes === "string" && a.contentBytes.length > 0)
                    .map((a) => ({
                        name: pickAttachmentName(a.name, a.id),
                        contents: Buffer.from(a.contentBytes as string, "base64"),
                    }));
                if (files.length === 0) {
                    return { paths: [] as readonly string[] };
                }
                const paths = await callCtx.host.scratch.addFiles(callCtx.event.id, files);
                return { paths };
            }),
    };
}

interface DraftReplyArgs {
    readonly body: string;
    readonly replyAll?: boolean;
}

function draftReplyTool(
    provider: O365Provider,
): PluginTool<DraftReplyArgs, { ok: true; drafted: true; draftId: string } | ToolFailure> {
    return {
        name: "draft_reply",
        description:
            "Create a draft reply to the current mail. Set replyAll=true to reply to every " +
            "recipient including CCs. The body is markdown; the plugin renders it as HTML.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["body"],
            properties: {
                body: { type: "string", description: "Markdown body of the reply." },
                replyAll: {
                    type: "boolean",
                    description: "When true, reply to all recipients of the original mail.",
                },
            },
        },
        execute: (args, callCtx) =>
            runTool(async () => {
                const { client, mailbox, messageId } = resolveMailEvent(
                    provider,
                    callCtx.event,
                    callCtx.host,
                );
                const html = renderMailHtml(args.body);
                const draft = await client.createReplyDraft(
                    mailbox,
                    messageId,
                    args.replyAll === true,
                    html,
                );
                return { drafted: true as const, draftId: draft.id };
            }),
    };
}

interface DraftNewArgs {
    readonly to: readonly string[];
    readonly cc?: readonly string[];
    readonly subject: string;
    readonly body: string;
}

function draftNewTool(
    provider: O365Provider,
): PluginTool<DraftNewArgs, { ok: true; drafted: true; draftId: string } | ToolFailure> {
    return {
        name: "draft_new",
        description:
            "Create a brand-new draft mail under the current mailbox. Recipients are bare " +
            "email addresses. Body is markdown; the plugin renders it as HTML.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["to", "subject", "body"],
            properties: {
                to: { type: "array", items: { type: "string" } },
                cc: { type: "array", items: { type: "string" } },
                subject: { type: "string" },
                body: { type: "string", description: "Markdown body of the mail." },
            },
        },
        execute: (args, callCtx) =>
            runTool(async () => {
                const { client, mailbox } = resolveMailEvent(provider, callCtx.event, callCtx.host);
                const html = renderMailHtml(args.body);
                const draft = await client.createDraft(mailbox, {
                    subject: args.subject,
                    bodyHtml: html,
                    to: toRecipients(args.to),
                    cc: args.cc ? toRecipients(args.cc) : [],
                });
                return { drafted: true as const, draftId: draft.id };
            }),
    };
}

interface SendReplyResult {
    readonly sent: boolean;
    readonly draftId?: string;
    readonly reason?: string;
}

function sendReplyTool(
    provider: O365Provider,
): PluginTool<DraftReplyArgs, ({ ok: true } & SendReplyResult) | ToolFailure> {
    return {
        name: "send_reply",
        description:
            "Send a reply to the current mail immediately. Set replyAll=true to include every " +
            "recipient of the original. When allowSend is disabled or a recipient is outside the " +
            "whitelist, the tool falls back to creating a draft and reports why.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["body"],
            properties: {
                body: { type: "string" },
                replyAll: { type: "boolean" },
            },
        },
        execute: (args, callCtx) =>
            runTool<SendReplyResult>(async () => {
                const { client, mailbox, messageId } = resolveMailEvent(
                    provider,
                    callCtx.event,
                    callCtx.host,
                );
                const config = readO365Config(callCtx.host);
                const recipients = collectReplyRecipients(callCtx.event, args.replyAll === true);
                const gate = checkSendGate(config, recipients);
                const html = renderMailHtml(args.body);
                if (!gate.allow) {
                    const draft = await client.createReplyDraft(
                        mailbox,
                        messageId,
                        args.replyAll === true,
                        html,
                    );
                    return { sent: false, draftId: draft.id, reason: gate.reason };
                }
                await client.sendReply(mailbox, messageId, args.replyAll === true, html);
                return { sent: true };
            }),
    };
}

function sendNewTool(
    provider: O365Provider,
): PluginTool<DraftNewArgs, ({ ok: true } & SendReplyResult) | ToolFailure> {
    return {
        name: "send_new",
        description:
            "Send a brand-new mail immediately. When allowSend is disabled or any recipient is " +
            "outside the whitelist, the tool falls back to creating a draft and reports why.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["to", "subject", "body"],
            properties: {
                to: { type: "array", items: { type: "string" } },
                cc: { type: "array", items: { type: "string" } },
                subject: { type: "string" },
                body: { type: "string" },
            },
        },
        execute: (args, callCtx) =>
            runTool<SendReplyResult>(async () => {
                const { client, mailbox } = resolveMailEvent(provider, callCtx.event, callCtx.host);
                const config = readO365Config(callCtx.host);
                const recipients = [...args.to, ...(args.cc ?? [])];
                const gate = checkSendGate(config, recipients);
                const html = renderMailHtml(args.body);
                const outgoing = {
                    subject: args.subject,
                    bodyHtml: html,
                    to: toRecipients(args.to),
                    cc: args.cc ? toRecipients(args.cc) : [],
                };
                if (!gate.allow) {
                    const draft = await client.createDraft(mailbox, outgoing);
                    return { sent: false, draftId: draft.id, reason: gate.reason };
                }
                await client.sendMail(mailbox, outgoing);
                return { sent: true };
            }),
    };
}

interface ForwardArgs {
    readonly to: readonly string[];
    readonly cc?: readonly string[];
    readonly comment?: string;
}

function draftForwardTool(
    provider: O365Provider,
): PluginTool<ForwardArgs, { ok: true; drafted: true; draftId: string } | ToolFailure> {
    return {
        name: "draft_forward",
        description:
            "Create a draft forwarding the current mail to new recipients. The comment is " +
            "markdown; the plugin renders it as HTML and places it above the quoted original. " +
            "The original attachments are carried over by Graph.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["to"],
            properties: {
                to: { type: "array", items: { type: "string" } },
                cc: { type: "array", items: { type: "string" } },
                comment: {
                    type: "string",
                    description: "Optional markdown note above the forwarded content.",
                },
            },
        },
        execute: (args, callCtx) =>
            runTool(async () => {
                const { client, mailbox, messageId } = resolveMailEvent(
                    provider,
                    callCtx.event,
                    callCtx.host,
                );
                const commentHtml = renderMailHtml(args.comment ?? "");
                const draft = await client.createForwardDraft(
                    mailbox,
                    messageId,
                    toRecipients(args.to),
                    args.cc ? toRecipients(args.cc) : [],
                    commentHtml,
                );
                return { drafted: true as const, draftId: draft.id };
            }),
    };
}

function sendForwardTool(
    provider: O365Provider,
): PluginTool<ForwardArgs, ({ ok: true } & SendReplyResult) | ToolFailure> {
    return {
        name: "send_forward",
        description:
            "Forward the current mail immediately. When allowSend is disabled or any recipient " +
            "is outside the whitelist, the tool falls back to creating a draft and reports why. " +
            "Original attachments are carried over by Graph.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["to"],
            properties: {
                to: { type: "array", items: { type: "string" } },
                cc: { type: "array", items: { type: "string" } },
                comment: {
                    type: "string",
                    description: "Optional markdown note above the forwarded content.",
                },
            },
        },
        execute: (args, callCtx) =>
            runTool<SendReplyResult>(async () => {
                const { client, mailbox, messageId } = resolveMailEvent(
                    provider,
                    callCtx.event,
                    callCtx.host,
                );
                const config = readO365Config(callCtx.host);
                const recipients = [...args.to, ...(args.cc ?? [])];
                const gate = checkSendGate(config, recipients);
                const commentHtml = renderMailHtml(args.comment ?? "");
                const to = toRecipients(args.to);
                const cc = args.cc ? toRecipients(args.cc) : [];
                if (!gate.allow) {
                    const draft = await client.createForwardDraft(
                        mailbox,
                        messageId,
                        to,
                        cc,
                        commentHtml,
                    );
                    return { sent: false, draftId: draft.id, reason: gate.reason };
                }
                await client.sendForward(mailbox, messageId, to, cc, commentHtml);
                return { sent: true };
            }),
    };
}

interface MoveArgs {
    readonly folder: FolderAlias;
}

function moveTool(
    provider: O365Provider,
): PluginTool<MoveArgs, { ok: true; moved: true; folder: string } | ToolFailure> {
    return {
        name: "move",
        description: "Move the current mail to a folder. Allowed folders: inbox, archive, trash.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["folder"],
            properties: {
                folder: { type: "string", enum: ["inbox", "archive", "trash"] },
            },
        },
        execute: (args, callCtx) =>
            runTool(async () => {
                if (!isFolderAlias(args.folder)) {
                    throw new Error(
                        `folder must be one of inbox|archive|trash, got: ${args.folder}`,
                    );
                }
                const { client, mailbox, messageId } = resolveMailEvent(
                    provider,
                    callCtx.event,
                    callCtx.host,
                );
                await client.moveMessage(mailbox, messageId, FOLDER_IDS[args.folder]);
                return { moved: true as const, folder: args.folder };
            }),
    };
}

/**
 * Convert bare email strings into the `{address, name?}` shape Graph
 * expects on a recipient. Names are not split out — if the agent
 * writes `"Anna <anna@example.com>"`, the whole thing lands in
 * `address` and Outlook treats it as a fully-qualified mailbox header,
 * which is what the agent intended.
 */
function toRecipients(addresses: readonly string[]): GraphRecipient[] {
    return addresses.map((address) => ({ address }));
}

/**
 * Apply the `allowSend` + `recipientWhitelist` gate. Returns `allow:
 * true` when every recipient is permitted, otherwise `allow: false`
 * with a sentence-form reason for the agent. The reason names the
 * first offending recipient so the agent can surface it to the user.
 */
function checkSendGate(
    config: ReturnType<typeof readO365Config>,
    recipients: readonly string[],
): { allow: true } | { allow: false; reason: string } {
    if (!config.allowSend) {
        return {
            allow: false,
            reason:
                "allowSend is false in config; created a draft instead. " +
                "Set mail.o365.allowSend to true in config.yml to enable direct sending.",
        };
    }
    if (config.recipientWhitelist.length === 0) {
        return { allow: true };
    }
    const whitelist = config.recipientWhitelist.map((e) => e.toLowerCase());
    for (const recipient of recipients) {
        const addr = recipient.toLowerCase();
        const domain = addr.includes("@") ? `@${addr.slice(addr.indexOf("@") + 1)}` : "";
        if (whitelist.includes(addr) || (domain.length > 1 && whitelist.includes(domain))) {
            continue;
        }
        return {
            allow: false,
            reason:
                `recipient ${recipient} is not in the recipientWhitelist; created a draft instead. ` +
                "Add the address or its @domain to mail.o365.recipientWhitelist to permit direct sending.",
        };
    }
    return { allow: true };
}

/**
 * For attachment file names taken straight from a Graph response,
 * fall back to `attachment-<id>` when the upstream `name` is empty and
 * strip path separators so the value is safe as a basename under
 * `/scratch/<event-id>/`. Mirrors the more thorough sanitizer used at
 * emit time without bringing in collision handling — `addFiles`
 * accepts duplicates because the tool layer rarely emits more than
 * one batch per event.
 */
function pickAttachmentName(name: string, id: string): string {
    const cleaned = name.replace(/[/\\]/g, "_").replace(/^\.+/, "");
    if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
        return `attachment-${id.replace(/[/\\]/g, "_")}`;
    }
    return cleaned;
}

/**
 * Pull the recipient set for a reply: the original sender (always),
 * plus the original to/cc list when `replyAll` is true. Used by
 * `send_reply` to gate against the recipient whitelist before
 * dispatching.
 */
function collectReplyRecipients(event: EventRow, replyAll: boolean): readonly string[] {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") {
        return [];
    }
    const out: string[] = [];
    const from = (payload as { from?: { address?: unknown } }).from;
    if (from && typeof from.address === "string" && from.address.length > 0) {
        out.push(from.address);
    }
    if (!replyAll) {
        return out;
    }
    for (const key of ["to", "cc"] as const) {
        const list = (payload as Record<string, unknown>)[key];
        if (!Array.isArray(list)) {
            continue;
        }
        for (const item of list) {
            if (
                item !== null &&
                typeof item === "object" &&
                typeof (item as { address?: unknown }).address === "string"
            ) {
                out.push((item as { address: string }).address);
            }
        }
    }
    return out;
}
