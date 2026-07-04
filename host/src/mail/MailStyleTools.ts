import {
    type MailStyleTemplate,
    type PluginTool,
    runJsonTool,
    ToolError,
} from "@getfamiliar/shared";
import type { MailStyleStore } from "./MailStyleStore.js";

/** Dependencies the core `mailstyle_*` tools need at construction. */
export interface MailStyleToolsDeps {
    readonly store: MailStyleStore;
}

/**
 * Build the three core `mailstyle_*` tools: `get`, `list`, `update`.
 * Plugin-agnostic — backed by {@link MailStyleStore} writing under
 * `data/mail/templates/<mailbox>/<name>.json`. Plugins (mail providers)
 * read templates via `ctx.getMailStyleTemplate`; agents read + write
 * them via these tools.
 */
export function buildMailStyleTools(deps: MailStyleToolsDeps): readonly PluginTool[] {
    return [getTool(deps), listTool(deps), updateTool(deps)].map((t) => ({
        ...t,
        groups: [...(t.groups ?? []), "mailstyle"],
    }));
}

interface GetArgs {
    readonly mailbox?: string;
    readonly name?: string;
}

function getTool(deps: MailStyleToolsDeps): PluginTool<GetArgs, object | null> {
    return {
        name: "mailstyle_get",
        description:
            "Return the per-mailbox style template (signature, textStyle, " +
            "usePlainText, useSignatureOnReplies, useSignatureOnForwards) " +
            "as JSON, or `null` when no file exists for this " +
            '(mailbox, name) pair. `name` defaults to `"default"`.',
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["mailbox"],
            properties: {
                mailbox: {
                    type: "string",
                    description: "Mailbox address, e.g. `alice@example.com`.",
                },
                name: {
                    type: "string",
                    description: "Template name. Defaults to `default`.",
                },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const mailbox = requireMailbox(args.mailbox);
                const name = validateName(args.name);
                const tpl = await deps.store.get(mailbox, name);
                return tpl ?? (null as unknown as object);
            }, callCtx.toolRunContext),
    };
}

function listTool(deps: MailStyleToolsDeps): PluginTool<Record<string, never>, object> {
    return {
        name: "mailstyle_list",
        description:
            "List every mail style template that exists on disk as " +
            "`{mailbox, name}` tuples. Use `mailstyle_get` to read a " +
            "specific one.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
        },
        execute: (_args, callCtx) =>
            runJsonTool(async () => {
                const items = await deps.store.list();
                return { templates: items };
            }, callCtx.toolRunContext),
    };
}

interface UpdateArgs {
    readonly mailbox?: string;
    readonly name?: string;
    readonly signature?: string;
    readonly textStyle?: string;
    readonly usePlainText?: boolean;
    readonly useSignatureOnReplies?: boolean;
    readonly useSignatureOnForwards?: boolean;
}

function updateTool(deps: MailStyleToolsDeps): PluginTool<UpdateArgs, object> {
    return {
        name: "mailstyle_update",
        level: "privileged",
        description:
            "Create or update the per-mailbox style template. Partial-update " +
            "semantics: omitted fields keep their current value (or default " +
            'to `""` / `false` on create). `mailbox` is required; `name` ' +
            'defaults to `"default"`. Writes to ' +
            "`data/mail/templates/<mailbox>/<name>.json`. Returns the new " +
            "full template.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["mailbox"],
            properties: {
                mailbox: { type: "string" },
                name: { type: "string", description: "Defaults to `default`." },
                signature: {
                    type: "string",
                    description: "HTML fragment; no `<html>`/`<head>`/`<body>` wrapper.",
                },
                textStyle: {
                    type: "string",
                    description:
                        "CSS declarations like " +
                        "`font-family: Calibri; font-size: 11pt; color: #1f1f1f`.",
                },
                usePlainText: { type: "boolean" },
                useSignatureOnReplies: { type: "boolean" },
                useSignatureOnForwards: { type: "boolean" },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const mailbox = requireMailbox(args.mailbox);
                const name = validateName(args.name);
                const patch: { -readonly [K in keyof MailStyleTemplate]?: MailStyleTemplate[K] } =
                    {};
                if (args.signature !== undefined) patch.signature = args.signature;
                if (args.textStyle !== undefined) patch.textStyle = args.textStyle;
                if (args.usePlainText !== undefined) patch.usePlainText = args.usePlainText;
                if (args.useSignatureOnReplies !== undefined) {
                    patch.useSignatureOnReplies = args.useSignatureOnReplies;
                }
                if (args.useSignatureOnForwards !== undefined) {
                    patch.useSignatureOnForwards = args.useSignatureOnForwards;
                }
                return deps.store.update(mailbox, name, patch);
            }, callCtx.toolRunContext),
    };
}

/**
 * Validate `mailbox`. Rejects empty / missing / path-separator-bearing
 * values — the address becomes a directory name on disk. Lowercases for
 * consistency with the rest of the mail subsystem (login store, etc.).
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
 * Validate optional `name`. Defaults to `"default"`. Rejects path
 * separators and `..` to keep the address-space safe; otherwise lets
 * the value through verbatim.
 */
function validateName(value: unknown): string {
    if (value === undefined || value === null) {
        return "default";
    }
    if (typeof value !== "string" || value.length === 0) {
        throw new ToolError("INVALID_ARGUMENT", "`name` must be a non-empty string when provided.");
    }
    if (value.includes("/") || value.includes("\\") || value.includes("..")) {
        throw new ToolError("INVALID_ARGUMENT", "`name` must not contain path separators or `..`.");
    }
    return value;
}
