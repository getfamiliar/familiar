/**
 * Conservative e-mail address sanitizer for payload metadata.
 *
 * Anything routed through here is safe to pass as a filename component
 * — e.g. `workspace/people/<address>.md` — without any further
 * escaping by the handler. The rule we enforce is **stricter than RFC
 * 5322**: we reject syntactically-valid forms that would enable
 * path-traversal or shell tricks (slashes, `..`, leading/trailing
 * dots, control chars, whitespace, NULs, …), trading interoperability
 * for safety.
 *
 * Untrusted upstream addresses that fail validation are replaced with
 * a sentinel and the raw original is preserved in a sibling field for
 * audit; handlers must NEVER use the raw field as a path component.
 */

/**
 * Strict regex for the local + domain shape. Local part: ASCII
 * alphanumeric plus a small set of common punctuation. Domain:
 * alphanumeric + dot + dash + a `.tld` of 2+ letters. Hyphens are
 * allowed inside the domain labels but the regex doesn't require them
 * to be in legal positions — the additional checks below cover the
 * remaining cases that matter for our threat model.
 */
const SAFE_ADDRESS_SHAPE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/;

/** RFC 5321 cap on overall length. */
const MAX_ADDRESS_LENGTH = 254;

/**
 * Compiled at runtime from a string so the regex literal in source
 * carries no raw control characters (which Biome's
 * `noControlCharactersInRegex` rule rejects, and which are easy to
 * corrupt under copy/paste). Matches every ASCII control char
 * (NUL–US, DEL) and both path separators.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the explicit intent here.
const CONTROL_OR_PATH_SEP = /[\u0000-\u001f\u007f/\\]+/g;

/**
 * Sentinel address substituted for any untrusted upstream value that
 * fails {@link isSafeEmailAddress}. Chosen to (a) parse as a syntactically
 * valid e-mail anywhere it might be re-used, (b) be obviously not a
 * real account, and (c) be safe as a filename component.
 */
export const UNSAFE_ADDRESS_SENTINEL = "invalid@invalid.invalid";

/**
 * Type guard for "safe to embed in a path." Rejects, in addition to
 * the regex shape:
 *
 * - `..` anywhere (double-dot — path traversal on every OS)
 * - leading / trailing dot in either the local or domain part
 * - empty string and over-length input
 * - non-string input (defensive — caller may hand us `unknown`)
 *
 * The regex already filters slashes, backslashes, control chars,
 * NULs, spaces, quotes, and angle brackets; this function layers
 * structural checks on top.
 */
export function isSafeEmailAddress(value: unknown): value is string {
    if (typeof value !== "string") {
        return false;
    }
    if (value.length === 0 || value.length > MAX_ADDRESS_LENGTH) {
        return false;
    }
    if (!SAFE_ADDRESS_SHAPE.test(value)) {
        return false;
    }
    if (value.includes("..")) {
        return false;
    }
    const atIdx = value.indexOf("@");
    const local = value.slice(0, atIdx);
    const domain = value.slice(atIdx + 1);
    if (local.startsWith(".") || local.endsWith(".")) {
        return false;
    }
    if (domain.startsWith(".") || domain.endsWith(".")) {
        return false;
    }
    if (domain.startsWith("-") || domain.endsWith("-")) {
        return false;
    }
    return true;
}

/**
 * Sanitize a display name. Returns `null` when the input is empty,
 * whitespace-only, or non-string. Otherwise strips control
 * characters and path separators (these never belong in a display
 * name and their presence is a red flag), collapses whitespace, and
 * truncates to 200 characters so a wildly long name can't flood the
 * prompt.
 *
 * The display name is not used as a path — it appears in the prompt
 * text — but the same characters that enable path tricks also enable
 * prompt-injection separator tricks, so we strip them defensively.
 */
export function sanitizeDisplayName(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const stripped = value.replace(CONTROL_OR_PATH_SEP, " ").replace(/\s+/g, " ").trim();
    if (stripped.length === 0) {
        return null;
    }
    return stripped.length > 200 ? `${stripped.slice(0, 200)}…` : stripped;
}

/**
 * Sanitized address bundle. `address` is always safe to use as a
 * filename component. `rawAddress` is `null` when the address passed
 * validation; otherwise it carries the original (possibly malicious)
 * bytes for audit — handlers must NEVER use it as a path.
 */
export interface SafeAddress {
    readonly name: string | null;
    readonly address: string;
    readonly rawAddress: string | null;
}

/**
 * Sanitize a Graph emailAddress wrapper. When the address shape is
 * safe, returns `{ name, address, rawAddress: null }` with `address`
 * **lower-cased** so that filename-keyed lookups (e.g.
 * `mail/rules/<address>.md`) are unambiguous regardless of how the
 * upstream system cased the bytes. SMTP defines the domain part as
 * case-insensitive; the local part is technically case-sensitive but
 * in practice every mainstream provider treats it as folded — and the
 * one place this matters (filesystem lookups against user-authored
 * rules files) is much better served by predictable lowercase keys
 * than by RFC-strict preservation.
 *
 * When unsafe, the address is replaced with {@link UNSAFE_ADDRESS_SENTINEL}
 * and the original is moved verbatim to `rawAddress` so the handler
 * can flag the mail without ever using the untrusted bytes as a path
 * component. `rawAddress` is NOT lowercased — it's audit data.
 */
export function sanitizeAddress(input: { name?: string; address: string }): SafeAddress {
    const name = sanitizeDisplayName(input.name);
    if (isSafeEmailAddress(input.address)) {
        return { name, address: input.address.toLowerCase(), rawAddress: null };
    }
    return {
        name,
        address: UNSAFE_ADDRESS_SENTINEL,
        rawAddress: typeof input.address === "string" ? input.address : "",
    };
}
