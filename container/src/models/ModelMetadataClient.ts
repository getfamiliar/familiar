import type { ModelMetaData } from "@getfamiliar/shared";

/**
 * Overall fetch timeout. The host-side lookup is a cheap in-memory map
 * read plus (rarely) a plugin call, so this only guards against a
 * gateway-level hang.
 */
const FETCH_TIMEOUT_MS = 5_000;

/** Logger surface the client needs — just a `warn` for non-fatal misses. */
interface WarnLogger {
    warn: (record: object, message: string) => void;
}

/** Response shape served by the bastion's `POST /model-metadata/`. */
interface ModelMetadataResponse {
    readonly meta: ModelMetaData | null;
}

/**
 * Ask the bastion's `/model-metadata/` gateway for a model's
 * capabilities. Called when an agentrun starts, once the model ref has
 * been resolved to a `(provider, model)` pair.
 *
 * Best-effort by design: model metadata is situational awareness, not a
 * hard dependency, so any failure (network error, timeout, non-200,
 * malformed body, or simply an unknown model) resolves to `undefined`
 * after logging a warning — it never blocks agentrun start. Mirrors the
 * resilience of `PromptBuilder.fetchEventContextSections`.
 *
 * @param bastionUrl The container's `BASTION_URL` env value.
 * @param provider Resolved provider id (e.g. `featherless`).
 * @param model Resolved model id.
 * @param log Logger child for the non-fatal warning path.
 * @returns The model's {@link ModelMetaData}, or `undefined` when no
 *   source knows it / the lookup couldn't complete.
 */
export async function fetchModelMetaData(
    bastionUrl: string,
    provider: string,
    model: string,
    log: WarnLogger,
): Promise<ModelMetaData | undefined> {
    const url = `${bastionUrl.replace(/\/$/, "")}/model-metadata/`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider, model }),
            signal: controller.signal,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            log.warn(
                { status: res.status, body: body.slice(0, 200) },
                "model-metadata gateway returned non-200",
            );
            return undefined;
        }
        const parsed = (await res.json()) as ModelMetadataResponse;
        return parsed?.meta ?? undefined;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err: message, provider, model }, "model-metadata fetch failed");
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}
