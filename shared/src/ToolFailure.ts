/**
 * Uniform `{ok:false, error:{status, code, message}}` envelope returned
 * to the agent when a plugin / core tool's body throws. Keeping the
 * shape stable across every tool means the agent's tool-call decoder
 * never has to parse free text: every failure has a numeric `status`
 * (HTTP-ish; 0 for non-network errors), a short machine `code`, and a
 * human-readable `message`.
 *
 * Originally extracted from the ms365 mail tools so both the ms365
 * plugin (`mail_*`) and the core calendar tools (`cal_*`) speak the
 * same dialect. Keeping the envelope here means new tool surfaces
 * inherit it for free.
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
 * Optional adaptor that converts a domain-specific exception into the
 * structured error payload. Used by callers that have an exception
 * class with its own `status` / `code` (e.g. Graph's `GraphError`) and
 * want it surfaced verbatim instead of being collapsed to the generic
 * `{status: 0, code: "ToolError"}` fallback.
 */
export type ToolFailureAdaptor = (
    err: unknown,
) => { status: number; code: string; message: string } | null;

/**
 * Run a tool body and normalise its return shape. Success bodies are
 * augmented with `ok: true`; if an `adaptor` is provided and it
 * matches the thrown error, the adaptor's `{status, code, message}` is
 * surfaced verbatim; otherwise the throw becomes a generic
 * `{status: 0, code: "ToolError"}`.
 *
 * Tools that have no domain-specific exception class can omit the
 * adaptor — every throw then becomes the generic envelope.
 */
export async function runTool<TResult extends object>(
    body: () => Promise<TResult>,
    adaptor?: ToolFailureAdaptor,
): Promise<({ ok: true } & TResult) | ToolFailure> {
    try {
        const result = await body();
        return { ok: true, ...result };
    } catch (err) {
        if (adaptor) {
            const mapped = adaptor(err);
            if (mapped) {
                return { ok: false, error: mapped };
            }
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            error: { status: 0, code: "ToolError", message },
        };
    }
}
