import { ToolError } from "@getfamiliar/shared";

/** Parsed item reference. */
export type StorageRef =
    | { readonly form: "path"; readonly mount: string; readonly path: string }
    | { readonly form: "id"; readonly mount: string; readonly realId: string };

/**
 * Parse an agent-supplied item reference:
 *
 * - path form `mount:/folder/file.ext` (root: `mount:/`)
 * - id form `mount#<providerId>`
 *
 * Whichever of `:` / `#` comes first separates the alias, so provider
 * ids may contain `:` and paths may contain `#`. Paths are normalized
 * (duplicate and trailing slashes dropped); `.` and `..` segments are
 * rejected rather than resolved.
 *
 * @param ref - The reference string.
 * @returns The parsed reference.
 * @throws ToolError `BadRef` on malformed input.
 */
export function parseRef(ref: string): StorageRef {
    if (typeof ref !== "string" || ref.trim().length === 0) {
        throw badRef(String(ref), "empty reference");
    }
    const trimmed = ref.trim();
    const colon = trimmed.indexOf(":");
    const hash = trimmed.indexOf("#");
    const sep = colon < 0 ? hash : hash < 0 ? colon : Math.min(colon, hash);
    if (sep <= 0) {
        throw badRef(trimmed, "missing mount alias");
    }
    const mount = trimmed.slice(0, sep);
    if (/[/\s]/.test(mount)) {
        throw badRef(trimmed, "invalid mount alias");
    }
    const rest = trimmed.slice(sep + 1);
    if (trimmed[sep] === "#") {
        if (rest.length === 0) {
            throw badRef(trimmed, "empty id after #");
        }
        return { form: "id", mount, realId: rest };
    }
    if (!rest.startsWith("/")) {
        throw badRef(trimmed, 'path must start with "/" (use "mount:/" for the root)');
    }
    return { form: "path", mount, path: normalizeItemPath(rest, trimmed) };
}

/**
 * Normalize an absolute in-drive path: collapse repeated slashes, drop a
 * trailing slash. `.` / `..` segments are rejected.
 *
 * @param path - Absolute path.
 * @param ref - Original reference, for the error message.
 * @throws ToolError `BadRef` on `.` / `..` segments.
 */
export function normalizeItemPath(path: string, ref: string = path): string {
    const segments = path.split("/").filter((s) => s.length > 0);
    if (segments.some((s) => s === "." || s === "..")) {
        throw badRef(ref, '"." and ".." segments are not allowed');
    }
    return `/${segments.join("/")}`;
}

/** @returns The id form `mount#realId`. */
export function formatIdRef(mount: string, realId: string): string {
    return `${mount}#${realId}`;
}

/** @returns The path form `mount:/path`, or `null` when the path is unknown. */
export function formatPathRef(mount: string, path: string | null): string | null {
    return path === null ? null : `${mount}:${path}`;
}

/**
 * Split an absolute path into its parent path and leaf name.
 *
 * @throws ToolError `BadRef` for the root, which has no leaf.
 */
export function splitParent(path: string): { parent: string; leaf: string } {
    const idx = path.lastIndexOf("/");
    const leaf = path.slice(idx + 1);
    if (leaf.length === 0) {
        throw badRef(path, "the root folder cannot be a target");
    }
    return { parent: idx === 0 ? "/" : path.slice(0, idx), leaf };
}

/** Join a folder path and a child name. */
export function joinPath(parent: string, name: string): string {
    return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

/** Build the agent-facing error for a malformed reference. */
function badRef(ref: string, reason: string): ToolError {
    return new ToolError(
        "BadRef",
        `invalid item reference "${ref}": ${reason}. Use "mount:/folder/file.ext" or "mount#<id>".`,
    );
}
