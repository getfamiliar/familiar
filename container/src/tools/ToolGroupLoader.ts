import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { HandlerFile } from "../HandlerFile.js";
import {
    type GroupDef,
    type GroupLookup,
    IDENT_PATTERN,
    parseGroupLine,
    RESERVED_GROUP_NAMES,
} from "./ToolFilter.js";

/**
 * Workspace-relative directory holding group definitions. Resolved
 * against the workspace root at lookup time. Files in this
 * directory are also gated as privileged-write by the fs tool layer.
 */
const TOOLGROUPS_DIR = "toolgroups";

/**
 * Build a lazy {@link GroupLookup} for `workspace/toolgroups/`. Each
 * call returns a fresh closure with its own parse cache; callers
 * (one per agentrun, today) get the latest snapshot of each file
 * without re-parsing groups they've already touched in the same
 * run.
 *
 * Files are only opened on first reference. A non-existent file
 * returns `undefined` (the resolver translates that to
 * `unknown group: <name>`); a malformed file throws on access with
 * the file path and line number — unrelated handlers are unaffected.
 *
 * Reserved built-in names (`all`, `system`, `mcp`, `none`) are
 * short-circuited inside the resolver and never reach this lookup.
 * As a defensive sanity check, the closure also rejects them so a
 * future caller can't accidentally bypass the resolver.
 */
export function createGroupLookup(): GroupLookup {
    const cache = new Map<string, GroupDef | undefined>();
    return (name: string): GroupDef | undefined => {
        if (RESERVED_GROUP_NAMES.has(name)) {
            throw new Error(
                `group name "${name}" is reserved as a built-in and must not be looked up`,
            );
        }
        if (cache.has(name)) {
            return cache.get(name);
        }
        if (!IDENT_PATTERN.test(name)) {
            throw new Error(`group name "${name}" is not a valid identifier`);
        }
        const dir = path.join(HandlerFile.getWorkspaceRoot(), TOOLGROUPS_DIR);
        const filePath = path.join(dir, `${name}.txt`);
        if (!existsSync(filePath)) {
            cache.set(name, undefined);
            return undefined;
        }
        const def = parseGroupFile(filePath, `${name}.txt`);
        cache.set(name, def);
        return def;
    };
}

/** Parse one `.txt` group file's contents into a `GroupDef`. */
function parseGroupFile(absolute: string, displayName: string): GroupDef {
    const raw = readFileSync(absolute, "utf-8");
    const lines = raw.split(/\r?\n/);
    const out: Array<NonNullable<ReturnType<typeof parseGroupLine>>> = [];
    for (let i = 0; i < lines.length; i++) {
        try {
            const entry = parseGroupLine(lines[i]);
            if (entry !== null) {
                out.push(entry);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`${path.join(TOOLGROUPS_DIR, displayName)}:${i + 1}: ${message}`);
        }
    }
    return out;
}
