import { randomBytes } from "node:crypto";
import { type PluginTool, runTextTool, ToolError } from "@getfamiliar/shared";
import { getActiveLogins } from "../auth/ActiveLogins.js";
import { type SampleResult, type SentExample, SentSampler } from "./SentSampler.js";

/** Args accepted by `ms365_get_sent_sample`. */
export interface SentSampleArgs {
    readonly mailbox?: string;
    readonly perKind?: number;
    readonly maxInlineBytes?: number;
    readonly maxRawBytes?: number;
}

/**
 * Build the ms365-specific `ms365_get_sent_sample` tool. The
 * extract-style handler uses it to collect example mails from a
 * mailbox's Sent Items and reason over them.
 *
 * Each example mail is staged as its own `.html` file under
 * `/scratch/<eventId>/` — one read with `file_read` covers the whole
 * mail, so the agent never has to paginate across mail boundaries. The
 * tool result is a rendered markdown summary plus a table listing the
 * staged files: `filepath | subject | bodyContentType | sent`. The
 * filename encodes the kind (`sample.reply.…`, `sample.forward.…`,
 * `sample.new.…`), so the consumer can group by kind without an extra
 * column.
 */
export function buildSentSampleTool(): PluginTool<SentSampleArgs, string> {
    return {
        // Final agent-facing tool name is `ms365_get_sent_sample` —
        // the ToolsRegistry prepends `<pluginId>_` automatically.
        name: "get_sent_sample",
        description:
            "Collect up to N example messages per kind (reply / forward / new) " +
            "from `mailbox`'s Sent Items and stage each as its own `.html` file. " +
            "Returns a sampler summary plus a markdown table with one row per " +
            "example: `filepath | subject | bodyContentType | sent`. Filenames " +
            "encode the kind (`sample.reply.…`, `sample.forward.…`, " +
            "`sample.new.…`), so you can group by kind from the path alone. " +
            "`perKind` defaults to 3; `maxInlineBytes` / `maxRawBytes` are the " +
            "same byte caps as SentSampler's options. Read individual files with " +
            "`file_read` — one read per file covers the whole mail. The summary " +
            "tells you how many messages were scanned and why some were dropped, " +
            "useful when fewer examples than requested came back.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["mailbox"],
            properties: {
                mailbox: {
                    type: "string",
                    description: "Mailbox address, e.g. `alice@example.com`.",
                },
                perKind: {
                    type: "number",
                    description: "Examples per kind. Default 3.",
                },
                maxInlineBytes: {
                    type: "number",
                    description:
                        "Per-example byte cap applied after quote stripping. Default 12000.",
                },
                maxRawBytes: {
                    type: "number",
                    description: "Drop-threshold on raw HTML body before stripping. Default 40000.",
                },
            },
        },
        execute: async (args, callCtx) =>
            runTextTool(async () => {
                const mailbox = requireMailbox(args.mailbox);
                const target = resolveTarget(mailbox);
                const sampler = new SentSampler(target);
                const { buckets, summary } = await sampler.sample({
                    perKind: args.perKind ?? 3,
                    maxInlineBytes: args.maxInlineBytes,
                    maxRawBytes: args.maxRawBytes,
                });
                const suffix = randomBytes(3).toString("hex");
                const flat = flattenExamples(buckets);
                if (flat.length === 0) {
                    return renderResult(summary, []);
                }
                const files = flat.map((entry) => ({
                    name: `sample.${entry.example.kind}.${entry.idx}.${suffix}.html`,
                    contents: Buffer.from(entry.example.innerHtml, "utf8"),
                }));
                const paths = await callCtx.host.scratch.addFiles(callCtx.event.id, files);
                const rows = flat.map((entry, i) => ({
                    filepath: paths[i],
                    subject: entry.example.subject,
                    bodyContentType: entry.example.contentType,
                    sent: entry.example.sentDateTime,
                }));
                return renderResult(summary, rows);
            }, callCtx.toolRunContext),
    };
}

/**
 * Walk the buckets in fixed order (reply → forward → new) and assign a
 * 1-based index within each kind. The fixed order keeps the table rows
 * predictable for the agent and is also what `addFiles` returns paths
 * for, so position-based zipping stays correct.
 */
function flattenExamples(buckets: SampleResult["buckets"]): {
    example: SentExample;
    idx: number;
}[] {
    const out: { example: SentExample; idx: number }[] = [];
    for (const kind of ["reply", "forward", "new"] as const) {
        buckets[kind].forEach((example, i) => {
            out.push({ example, idx: i + 1 });
        });
    }
    return out;
}

/**
 * Render the tool's text result: a one-line sampler summary followed by
 * a markdown table of staged files. If no examples were kept the table
 * is replaced with a `_(no examples)_` line so the agent still gets a
 * structured response.
 */
function renderResult(
    summary: SampleResult["summary"],
    rows: readonly {
        filepath: string;
        subject: string;
        bodyContentType: string;
        sent: string;
    }[],
): string {
    const lines: string[] = [];
    lines.push(
        `Scanned ${summary.scanned}, kept ${summary.kept}. ` +
            `Dropped: meeting ${summary.droppedAsMeeting}, ` +
            `oversize ${summary.droppedAsOversize}, ` +
            `bucket-full ${summary.droppedAsBucketFull}, ` +
            `empty-after-strip ${summary.droppedAsEmptyAfterStrip}.`,
    );
    lines.push("");
    if (rows.length === 0) {
        lines.push("_(no examples)_");
        return `${lines.join("\n")}\n`;
    }
    lines.push("| filepath | subject | bodyContentType | sent |");
    lines.push("|---|---|---|---|");
    for (const row of rows) {
        lines.push(
            `| ${row.filepath} | ${sanitizeCell(row.subject)} | ${row.bodyContentType} | ${row.sent} |`,
        );
    }
    return `${lines.join("\n")}\n`;
}

/**
 * Escape pipe and newline characters inside a markdown table cell so a
 * subject like `Re: Foo | Bar` doesn't split the row. Empty subjects
 * render as `(empty subject)` for readability, matching the prior
 * markdown rendering.
 */
function sanitizeCell(value: string): string {
    if (value.length === 0) {
        return "(empty subject)";
    }
    return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Validate `mailbox`. Same shape as the core `mailstyle_*` validators —
 * non-empty string, no path separators (defence in depth even though
 * the tool never writes path-derived filenames).
 */
function requireMailbox(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new ToolError(
            "INVALID_ARGUMENT",
            "`mailbox` is required and must be a non-empty string.",
        );
    }
    if (value.includes("/") || value.includes("\\") || value.includes("..")) {
        throw new ToolError(
            "INVALID_ARGUMENT",
            "`mailbox` must not contain path separators or `..`.",
        );
    }
    return value.toLowerCase();
}

/**
 * Resolve the mailbox to a {@link MailboxTarget} via the module-scoped
 * `LoginStore`. Mirrors `Ms365MailProvider.clientForMailbox` so any
 * mailbox a current login can reach is samplable, not only the polled
 * set.
 */
function resolveTarget(mailbox: string): import("./MailboxMap.js").MailboxTarget {
    const store = getActiveLogins();
    if (!store) {
        throw new ToolError(
            "NO_ACTIVE_LOGIN",
            "no active ms365 logins; run `./cli.sh ms365 login` and restart the daemon",
        );
    }
    const auth = store.byUpn(mailbox);
    if (!auth) {
        throw new ToolError(
            "UNKNOWN_MAILBOX",
            `no active ms365 login for ${mailbox}; run \`./cli.sh ms365 login\` to add one`,
        );
    }
    return {
        upn: mailbox,
        auth,
        mailbox,
        isShared: false,
    };
}
