import { ToolError } from "@getfamiliar/shared";

/**
 * Persisted shape for a tool-error entry — mirrors the SDK's
 * `type: 'tool-error'` content block but with `error` flattened to a
 * human-readable string the report renderer can show as-is.
 */
export interface PersistedToolError {
    readonly type: "tool-error";
    readonly toolCallId: string;
    readonly toolName: string;
    readonly error: string;
}

/**
 * Combine `step.toolResults` (success entries the SDK collects under
 * `type: 'tool-result'`) with any `tool-error` blocks found in
 * `step.content` so the audit row carries both. The SDK splits the two
 * streams: `toolResults` only contains successful calls, errors live in
 * `content`. Persisting both under a single column keeps the renderer
 * able to match a tool call to its outcome by `toolCallId` regardless of
 * whether the outcome was a success or a failure.
 */
export function mergeToolErrorsIntoResults(toolResults: unknown, content: unknown): unknown[] {
    const successes = Array.isArray(toolResults) ? toolResults : [];
    if (!Array.isArray(content)) {
        return [...successes];
    }
    const errors: PersistedToolError[] = [];
    for (const entry of content) {
        if (entry === null || typeof entry !== "object") {
            continue;
        }
        const e = entry as {
            type?: unknown;
            toolCallId?: unknown;
            toolName?: unknown;
            error?: unknown;
        };
        if (e.type !== "tool-error") {
            continue;
        }
        if (typeof e.toolCallId !== "string" || typeof e.toolName !== "string") {
            continue;
        }
        errors.push({
            type: "tool-error",
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            error: stringifyToolError(e.error),
        });
    }
    return [...successes, ...errors];
}

/**
 * Flatten the SDK's `error: unknown` field on a `tool-error` block into
 * a single human-readable string. The common case is a {@link ToolError}
 * reconstructed by `ToolsClient` from the gateway's `{ok:false, code,
 * message, status?}` envelope — we render those as `<code>: <message>`
 * (plus status when present) so the report shows the machine-readable
 * code alongside the human text. Other throws fall back to the
 * `Error.message` / `String(err)` ladder.
 */
export function stringifyToolError(err: unknown): string {
    if (err instanceof ToolError) {
        const head = `${err.code}: ${err.message}`;
        return err.status === undefined ? head : `${head} (status ${err.status})`;
    }
    if (err instanceof Error) {
        return err.message;
    }
    if (err === undefined || err === null) {
        return "tool error";
    }
    if (typeof err === "string") {
        return err;
    }
    try {
        return JSON.stringify(err);
    } catch {
        return String(err);
    }
}
