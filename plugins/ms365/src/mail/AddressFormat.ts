import {
    isSafeEmailAddress,
    type SafeAddress,
    sanitizeAddress,
    sanitizeDisplayName,
    UNSAFE_ADDRESS_SENTINEL,
} from "./Sanitize.js";

/**
 * Pure address-formatting helpers used by both the polling loop and
 * the send/draft tools. Kept apart from HTTP-specific code so the
 * sanitizer surface stays usable from any caller.
 */

/**
 * Format a sanitized address for the prompt text the agent reads.
 * Renders `"Name <addr@x>"` when a display name is present,
 * `"addr@x"` otherwise. When the upstream address was unsafe and has
 * been replaced with the sentinel, prefix with `[suspicious sender] `
 * so the agent visibly knows the address was tampered with (and the
 * raw bytes live in the payload's `rawAddress` field for audit, not
 * for path use).
 */
export function formatAddress(addr: SafeAddress | null): string {
    if (!addr) {
        return "";
    }
    const display =
        addr.name && addr.name !== addr.address ? `${addr.name} <${addr.address}>` : addr.address;
    return addr.rawAddress !== null ? `[suspicious sender] ${display}` : display;
}

/**
 * Sanitize a Graph emailAddress wrapper for inclusion in the event
 * payload. Every address that flows into the payload goes through
 * this — the resulting `address` field is always safe for
 * `workspace/people/<address>.md`-style filename construction. When
 * the upstream value fails validation, `address` is the safe
 * {@link UNSAFE_ADDRESS_SENTINEL} and the raw original moves to
 * `rawAddress` for audit. Handlers MUST NOT use `rawAddress` as a
 * path component.
 */
export function flatAddress(addr: {
    emailAddress: { name?: string; address: string };
}): SafeAddress {
    return sanitizeAddress(addr.emailAddress);
}

export { isSafeEmailAddress, type SafeAddress, sanitizeDisplayName, UNSAFE_ADDRESS_SENTINEL };
