import type { HostContext, PluginTool, PluginToolCallContext } from "effective-assistant-shared";

/**
 * Args the agent supplies. `body` carries the prose draft the model
 * composed; the mail id is sourced from `event.payload`, not from
 * the model, so the model can't be tricked into drafting against
 * the wrong message.
 */
export interface DraftResponseArgs {
    readonly body: string;
}

/**
 * Result handed back to the model. Lean payload so the tool-loop
 * isn't dragged into rendering large mail bodies on the response
 * path; the host-side draft creation runs in the background and the
 * agent only needs confirmation that it happened.
 */
export interface DraftResponseResult {
    readonly drafted: true;
    readonly messageId: string;
}

/**
 * First plugin-contributed tool, paired with the upcoming mail
 * rewrite that retires the Softeria MCP. v1 body is intentionally a
 * stub — it pulls the originating message id out of `event.payload`
 * (where the mail emitter already puts it), logs the inputs, and
 * returns success. The real Microsoft Graph / IMAP draft-create
 * call lands when the rest of mail handling moves into this plugin.
 *
 * The tool runs inside the host process, with full access to the
 * mail plugin's own dependencies. The container's agent never sees
 * any mail SDK — it only sees this tool's JSON schema.
 */
export function draftResponseTool(
    _ctx: HostContext,
): PluginTool<DraftResponseArgs, DraftResponseResult> {
    return {
        name: "draft_response",
        description:
            "Draft a reply to the mail this agentrun is reacting to. The mail id is " +
            "taken from the triggering event automatically, so you only need to " +
            "supply the reply body. Returns confirmation that the draft was created.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["body"],
            properties: {
                body: {
                    type: "string",
                    description:
                        "Plain-text body of the reply. Newlines preserved. Do not include " +
                        "headers or quoted original — those are added host-side.",
                },
            },
        },
        execute: async (
            args: DraftResponseArgs,
            { event, log }: PluginToolCallContext,
        ): Promise<DraftResponseResult> => {
            const messageId = extractMessageId(event.payload);
            if (messageId === undefined) {
                throw new Error(
                    "event.payload has no messageId — draft_response can only run on " +
                        "mail events whose payload carries the originating message id.",
                );
            }
            log.info(
                { messageId, bodyLength: args.body.length },
                "draft_response stub: would create draft via mail backend",
            );
            return { drafted: true, messageId };
        },
    };
}

/**
 * Pull `messageId` out of the event payload defensively — the
 * payload is `unknown` at the bus boundary and a forgiving extraction
 * is friendlier than a JSON Schema validator failure path.
 */
function extractMessageId(payload: unknown): string | undefined {
    if (payload === null || typeof payload !== "object") {
        return undefined;
    }
    const id = (payload as { messageId?: unknown }).messageId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}
