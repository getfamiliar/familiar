import { signatureToPlainText } from "./MailStyleTemplate.js";

/**
 * Minimum length the anchor substring must reach to count as
 * distinctive. Eight characters is long enough to be unlikely to occur
 * by chance in unrelated mail bodies (no false positives from greetings
 * like "Thanks" or "Regards") and short enough that a real signature
 * almost always has one (last name + first initial, phone number,
 * company name, etc.).
 */
export const MIN_ANCHOR_LENGTH = 8;

/**
 * Pick a stable substring from a signature that we can search for in
 * other mail bodies to decide whether the user "uses their signature
 * here". Process:
 *
 *  1. Run the signature HTML through {@link signatureToPlainText} so we
 *     compare against actual text, not HTML markup.
 *  2. Walk every contiguous non-whitespace run in the result.
 *  3. Return the longest run that meets {@link MIN_ANCHOR_LENGTH}.
 *
 * Returns `null` when nothing qualifies — e.g. signatures consisting
 * only of short tokens ("Bob") or being effectively empty. Callers
 * treat `null` as "no anchor available", which is graceful failure
 * (the relevant booleans default to `false`).
 */
export function extractAnchor(signature: string): string | null {
    const text = signatureToPlainText(signature);
    if (text.length === 0) {
        return null;
    }
    let best: string | null = null;
    for (const run of text.split(/\s+/)) {
        if (run.length < MIN_ANCHOR_LENGTH) {
            continue;
        }
        if (best === null || run.length > best.length) {
            best = run;
        }
    }
    return best;
}
