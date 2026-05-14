import type { McpClient } from "effective-assistant-shared";
import {
    isSafeEmailAddress,
    type SafeAddress,
    sanitizeAddress,
    sanitizeDisplayName,
    UNSAFE_ADDRESS_SENTINEL,
} from "./Sanitize.js";

/**
 * One Graph MailFolder message projection — the fields the polling
 * loop requests via `$select`. Anything not listed here is dropped
 * by Graph before we see it, so the type can be narrow.
 */
export interface GraphMailMessage {
    readonly id: string;
    readonly internetMessageId: string;
    readonly subject: string | null;
    readonly receivedDateTime: string;
    readonly bodyPreview: string;
    readonly from: { readonly emailAddress: { name?: string; address: string } } | null;
    readonly toRecipients: ReadonlyArray<{ emailAddress: { name?: string; address: string } }>;
    readonly ccRecipients: ReadonlyArray<{ emailAddress: { name?: string; address: string } }>;
}

/**
 * One entry in the ms365-mcp-server `list-accounts` response. The
 * tool returns `{ accounts: [{ email, name, isDefault }, ...],
 * count, tip }`; we only need the `email` for downstream tool calls
 * and for the watermark key. `name` is kept for the CLI table only.
 */
export interface GraphAccount {
    readonly email: string;
    readonly name: string | null;
    readonly isDefault: boolean;
}

/**
 * Shape of the ms365-mcp-server `verify-login` response. Returned
 * by `authManager.testLogin()` — either a success with the
 * authenticated user's display info, or a failure with a reason.
 *
 * Source of truth:
 * https://github.com/softeria/ms-365-mcp-server/blob/main/src/auth.ts
 */
export type VerifyLoginResponse =
    | {
          readonly success: true;
          readonly message: string;
          readonly userData: {
              readonly displayName: string;
              readonly userPrincipalName: string;
          };
      }
    | {
          readonly success: false;
          readonly message: string;
      };

/**
 * Call an MCP tool and decode its primary content payload as JSON.
 * The ms365 MCP returns Graph-shaped JSON inside `content[0].text`;
 * normal MCP servers may return structuredContent directly. This
 * helper handles both.
 *
 * Throws when the call itself failed (`isError: true`), when no
 * content is present, or when the text isn't valid JSON. The caller
 * is expected to catch and log per call site so a single tool
 * failure doesn't tank the whole poll.
 */
export async function callJsonTool<T = unknown>(
    client: McpClient,
    name: string,
    args?: Record<string, unknown>,
): Promise<T> {
    // Always pass an object for `arguments`, even on no-arg tools.
    // The MCP spec allows the field to be omitted, but several servers
    // (notably ms365-mcp-server's zod schemas) require an object —
    // they reject `undefined` with -32602 "expected object, received
    // undefined." `{}` works on every server we've tried.
    const response = (await client.callTool({
        name,
        arguments: args ?? {},
        // biome-ignore lint/suspicious/noExplicitAny: SDK response is loosely typed and varies per server.
    })) as any;
    if (response.isError === true) {
        const text = extractText(response);
        throw new Error(`MCP tool "${name}" returned isError=true: ${text}`);
    }
    if (response.structuredContent !== undefined) {
        return response.structuredContent as T;
    }
    const text = extractText(response);
    if (text === null) {
        throw new Error(`MCP tool "${name}" returned no usable content`);
    }
    try {
        return JSON.parse(text) as T;
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`MCP tool "${name}" returned non-JSON content: ${cause}`);
    }
}

/**
 * Pull the first text part out of an MCP tool response. Returns
 * `null` when the response has no text part — caller decides whether
 * that's an error.
 */
// biome-ignore lint/suspicious/noExplicitAny: response shape is server-specific.
function extractText(response: any): string | null {
    const content = response?.content;
    if (!Array.isArray(content)) {
        return null;
    }
    for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") {
            return part.text;
        }
    }
    return null;
}

/**
 * Format a sanitized address for the prompt text the agent reads.
 * Renders `"Name <addr@x>"` when a display name is present,
 * `"addr@x"` otherwise. When the upstream address was unsafe and
 * has been replaced with the sentinel, prefix with `[suspicious
 * sender] ` so the agent visibly knows the address was tampered with
 * (and the raw bytes live in the payload's `rawAddress` field for
 * audit, NOT for path use).
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

// Re-exports so callers can import the sanitizer surface from one
// place without reaching into the Sanitize module.
export { isSafeEmailAddress, type SafeAddress, sanitizeDisplayName, UNSAFE_ADDRESS_SENTINEL };
