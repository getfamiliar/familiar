import { APICallError } from "@ai-sdk/provider";

/**
 * Render an inference error in a form that's useful both in the
 * daemon log and on `agentruns.error`. For Vercel AI SDK
 * `APICallError` instances we surface the HTTP status code, the
 * upstream URL, the error's own message, and a body excerpt — most
 * 4xx/5xx responses carry a JSON body that explains the cause much
 * better than the bare status text. For everything else we fall
 * back to `err.message` (Error) or `String(err)`.
 *
 * Used by `AgentrunWatcher` when settling a `failed` row and by
 * `AgentRunner` when recording the latest error on a postponed run,
 * so a `psql` of `agentruns.error` reads "The model API answered
 * with 404 Not Found at https://… — <body>" instead of the opaque
 * "Not Found".
 */
export function formatInferenceError(err: unknown): string {
    if (APICallError.isInstance(err)) {
        const status = err.statusCode ?? "?";
        const url = err.url ?? "(unknown URL)";
        const body = excerpt(err.responseBody, 400);
        const head = `The model API answered with ${status} ${err.message} at ${url}`;
        return body ? `${head}\n${body}` : head;
    }
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

/**
 * Trim a response body for log readability. Returns `null` when
 * the body is missing or empty after trim; truncates with an
 * ellipsis when longer than `max` characters.
 */
function excerpt(body: string | undefined, max: number): string | null {
    if (!body) {
        return null;
    }
    const trimmed = body.trim();
    if (trimmed.length === 0) {
        return null;
    }
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
