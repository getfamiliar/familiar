import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { HandlerFile } from "../HandlerFile.js";
import { ALL_GROUP_NAME, type GroupDef, IDENT_PATTERN, parseGroupLine } from "./ToolFilter.js";

/**
 * Workspace-relative directory holding group definitions. Resolved
 * against the workspace root at load time. Files in this directory
 * are also gated as privileged-write by the fs tool layer.
 */
const TOOLGROUPS_DIR = "toolgroups";

/**
 * Read every `.txt` file under `workspace/toolgroups/`, parse each
 * line into a {@link GroupLineEntry}, and return a map of group name
 * → ordered entry list.
 *
 * The directory not existing is fine: empty map. A file whose stem
 * doesn't match {@link IDENT_PATTERN} is rejected — the stem is the
 * group's name and must obey identifier rules so handlers can refer
 * to it. A file named `all.txt` is rejected too: `all` is reserved
 * for the built-in "every available tool" group.
 *
 * Failures throw — the agentrun fails loud rather than running with
 * surprise behaviour. Each error names the offending file (and line
 * number when applicable).
 */
export function loadGroups(): Map<string, GroupDef> {
    const dir = path.join(HandlerFile.getWorkspaceRoot(), TOOLGROUPS_DIR);
    if (!existsSync(dir)) {
        return new Map();
    }
    const groups = new Map<string, GroupDef>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".txt")) {
            continue;
        }
        const stem = entry.name.slice(0, -".txt".length);
        if (stem === ALL_GROUP_NAME) {
            throw new Error(
                `${path.join(TOOLGROUPS_DIR, entry.name)}: "${ALL_GROUP_NAME}" is a reserved built-in group name`,
            );
        }
        if (!IDENT_PATTERN.test(stem)) {
            throw new Error(
                `${path.join(TOOLGROUPS_DIR, entry.name)}: filename stem must match ${IDENT_PATTERN}`,
            );
        }
        const filePath = path.join(dir, entry.name);
        groups.set(stem, parseGroupFile(filePath, entry.name));
    }
    return groups;
}

/** Parse one `.txt` group file's contents into a `GroupDef`. */
function parseGroupFile(absolute: string, displayName: string): GroupDef {
    const raw = readFileSync(absolute, "utf-8");
    const lines = raw.split(/\r?\n/);
    const out: GroupDef extends ReadonlyArray<infer T> ? T[] : never = [];
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
