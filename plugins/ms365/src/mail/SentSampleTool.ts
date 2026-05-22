import { randomBytes } from "node:crypto";
import { type PluginTool, runJsonTool, ToolError } from "@getfamiliar/shared";
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
 * extract-style handler uses it to get three on-disk sample files (one
 * per mail kind) that it then reads, reasons over, and turns into a
 * `mailstyle_update` call.
 *
 * The handler-driven flow needs the samples as readable files (so the
 * agent can `file_read` them and quote from them), not as bytes inlined
 * in the tool result — which would also blow past prompt limits at
 * realistic example counts. We stage them via `ctx.scratch.addFiles`
 * with a random 6-char suffix so repeat invocations within the same
 * event don't collide.
 */
export function buildSentSampleTool(): PluginTool<SentSampleArgs, object> {
    return {
        // Final agent-facing tool name is `ms365_get_sent_sample` —
        // the ToolsRegistry prepends `<pluginId>_` automatically.
        name: "get_sent_sample",
        description:
            "Collect up to N example messages per kind (reply / forward / new) " +
            "from `mailbox`'s Sent Items and write them as scratch files. Returns " +
            "the three absolute paths the handler reads back. `perKind` defaults " +
            "to 3; `maxInlineBytes` / `maxRawBytes` are the same byte caps as " +
            "SentSampler's options. Each sample file is a markdown document " +
            "listing the examples (subject, sent date, `bodyContentType`, body). " +
            "The summary in the tool result tells you how many messages were " +
            "scanned and why some were dropped — useful when fewer examples " +
            "than requested came back.",
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
            runJsonTool(async () => {
                const mailbox = requireMailbox(args.mailbox);
                const target = resolveTarget(mailbox);
                const sampler = new SentSampler(target);
                const { buckets, summary } = await sampler.sample({
                    perKind: args.perKind ?? 3,
                    maxInlineBytes: args.maxInlineBytes,
                    maxRawBytes: args.maxRawBytes,
                });
                const suffix = randomBytes(3).toString("hex");
                const files = [
                    {
                        name: `sample.reply.${suffix}.md`,
                        contents: Buffer.from(
                            renderSampleFile("reply", mailbox, buckets.reply, summary),
                            "utf8",
                        ),
                    },
                    {
                        name: `sample.forward.${suffix}.md`,
                        contents: Buffer.from(
                            renderSampleFile("forward", mailbox, buckets.forward, summary),
                            "utf8",
                        ),
                    },
                    {
                        name: `sample.new.${suffix}.md`,
                        contents: Buffer.from(
                            renderSampleFile("new", mailbox, buckets.new, summary),
                            "utf8",
                        ),
                    },
                ];
                const paths = await callCtx.host.scratch.addFiles(callCtx.event.id, files);
                return {
                    sampleFiles: { reply: paths[0], forward: paths[1], new: paths[2] },
                    summary,
                };
            }, callCtx.toolRunContext),
    };
}

/**
 * Build the markdown document for one sample bucket. Includes the
 * sampler summary at the top (so the agent can decide whether the
 * extraction is healthy) and each example as a fenced HTML block with a
 * small header carrying subject, sent date, and `bodyContentType`. The
 * `bodyContentType` is the deterministic signal the extract-style
 * handler counts to set `usePlainText` on the resulting template.
 */
function renderSampleFile(
    kind: "reply" | "forward" | "new",
    mailbox: string,
    examples: readonly SentExample[],
    summary: SampleResult["summary"],
): string {
    const lines: string[] = [];
    lines.push(`# Sent mail samples — kind: ${kind} (mailbox: ${mailbox})`);
    lines.push("");
    lines.push(
        `Got ${examples.length} example${examples.length === 1 ? "" : "s"}. ` +
            `Sampler summary: scanned ${summary.scanned}, kept ${summary.kept}; ` +
            `dropped: meeting ${summary.droppedAsMeeting}, ` +
            `oversize ${summary.droppedAsOversize}, ` +
            `bucket-full ${summary.droppedAsBucketFull}, ` +
            `empty-after-strip ${summary.droppedAsEmptyAfterStrip}.`,
    );
    lines.push("");
    if (examples.length === 0) {
        lines.push("_(no examples — bucket was empty after filtering)_");
        lines.push("");
        return `${lines.join("\n")}\n`;
    }
    examples.forEach((ex, idx) => {
        lines.push("---");
        lines.push("");
        lines.push(`## Example ${idx + 1}`);
        lines.push(`- subject: ${ex.subject || "(empty subject)"}`);
        lines.push(`- sent: ${ex.sentDateTime}`);
        lines.push(`- bodyContentType: ${ex.contentType}`);
        lines.push("");
        lines.push("```html");
        lines.push(ex.innerHtml);
        lines.push("```");
        lines.push("");
    });
    return `${lines.join("\n")}\n`;
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
