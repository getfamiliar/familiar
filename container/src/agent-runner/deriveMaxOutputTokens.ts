import type { ModelMetaData } from "@getfamiliar/shared";

/**
 * Default fraction of a model's context window used as the per-step
 * output ceiling when the model's metadata declares no explicit
 * `outputLimit`. The remainder of the window is left as headroom for the
 * prompt. Overridable via `inference.outputFallbackPercentage` in
 * `config.yml` (reflected to the container as the
 * `INFERENCE_OUTPUT_FALLBACK_PERCENTAGE` env var).
 *
 * Deliberately applied with no absolute backstop: a large-context model
 * gets a correspondingly large output budget. There is no token counter
 * in this codebase, so the fraction is a coarse proxy for "context minus
 * prompt", not a precise reservation.
 */
export const DEFAULT_OUTPUT_FALLBACK_FRACTION = 0.7;

/**
 * Last-resort output cap used only when no metadata is available at all
 * (neither `outputLimit` nor `contextLimit`). Conservative enough to be
 * accepted by essentially any model's API without a 400.
 */
export const ABSOLUTE_DEFAULT_OUTPUT_TOKENS = 4096;

/**
 * Clamp a configured fallback fraction into the only range that makes
 * sense: greater than 0 and at most 1. A value above 1 (e.g. someone
 * writing `70` instead of `0.70`) would otherwise ask for many times the
 * context window as output; a non-positive or non-finite value would
 * yield a zero/negative ceiling. Both collapse to a usable fraction
 * rather than a broken `max_tokens`.
 *
 * @param fraction The raw configured fraction.
 * @returns `1` when above 1; {@link DEFAULT_OUTPUT_FALLBACK_FRACTION}
 *   when non-finite or not positive; otherwise the value unchanged.
 */
function clampFraction(fraction: number): number {
    if (!Number.isFinite(fraction) || fraction <= 0) {
        return DEFAULT_OUTPUT_FALLBACK_FRACTION;
    }
    return Math.min(fraction, 1);
}

/**
 * Resolve the model's output-token ceiling — the largest `max_tokens`
 * value it can sensibly be asked for, independent of any per-handler
 * policy.
 *
 * Precedence: a declared `outputLimit` is the provider's own truth and
 * wins. Otherwise the ceiling is a fraction of the context window
 * (reserving the rest for the prompt). With no metadata at all, falls
 * back to {@link ABSOLUTE_DEFAULT_OUTPUT_TOKENS}.
 *
 * @param meta The model's metadata, or `undefined` when the lookup
 *   couldn't complete.
 * @param fraction Fraction of `contextLimit` to use when `outputLimit` is
 *   absent. Defaults to {@link DEFAULT_OUTPUT_FALLBACK_FRACTION}; clamped
 *   into `(0, 1]` (see {@link clampFraction}).
 * @returns The model's output-token ceiling.
 */
export function resolveModelCeiling(
    meta: ModelMetaData | undefined,
    fraction: number = DEFAULT_OUTPUT_FALLBACK_FRACTION,
): number {
    if (meta?.outputLimit !== undefined) {
        return meta.outputLimit;
    }
    if (meta?.contextLimit !== undefined) {
        return Math.round(meta.contextLimit * clampFraction(fraction));
    }
    return ABSOLUTE_DEFAULT_OUTPUT_TOKENS;
}

/**
 * Derive the effective per-step output-token cap from the model's
 * capability ceiling and the handler's declared policy.
 *
 * A handler that declares nothing inherits the model's true ceiling
 * (tending to the useful max). A handler that declares a value keeps it,
 * but always clamped down to the ceiling so it can never ask for more
 * than the model / context allows (which would trigger an API 400 or a
 * silent cap).
 *
 * @param meta The model's metadata, or `undefined` when unavailable.
 * @param declared The handler's `maxOutputTokens`, or `undefined` when
 *   the handler did not set one.
 * @param fraction Fraction of `contextLimit` to use when `outputLimit` is
 *   absent. Defaults to {@link DEFAULT_OUTPUT_FALLBACK_FRACTION}; clamped
 *   into `(0, 1]` (see {@link clampFraction}).
 * @returns The output-token cap to pass to the inference call.
 */
export function deriveMaxOutputTokens(
    meta: ModelMetaData | undefined,
    declared: number | undefined,
    fraction: number = DEFAULT_OUTPUT_FALLBACK_FRACTION,
): number {
    const ceiling = resolveModelCeiling(meta, fraction);
    return Math.min(declared ?? ceiling, ceiling);
}
