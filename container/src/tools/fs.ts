import { promises as fs } from "node:fs";
import path from "node:path";
import {
    type AgentRunRow,
    matchesAnyGlob,
    runJsonLinesTool,
    runJsonTool,
    ToolError,
    type ToolRunContext,
    truncateUtf8,
} from "@getfamiliar/shared";
import type { Tool, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { getWritablePaths } from "../env.js";
import { HandlerFile } from "../HandlerFile.js";

/**
 * Hard caps for the search-shaped tools. Picked to keep tool results
 * inside the model's context budget without further truncation:
 *
 * - `GLOB_MAX_RESULTS` — a noisy `**\/*` against a busy workspace can
 *   easily exceed thousands of paths; capping protects the model.
 * - `GREP_MAX_MATCHES` — same reasoning for `grep` hits.
 * - `GREP_MAX_CANDIDATE_FILES` — upper bound on how many files we
 *   *consider* scanning before giving up; protects the worker too.
 * - `GREP_MAX_FILE_BYTES` — skip large binaries / dumps; markdown,
 *   YAML, JSONL, code: all comfortably under this.
 * - `GREP_LINE_PREVIEW_CHARS` — long minified lines would otherwise
 *   blow past the per-match preview the model needs.
 */
const GLOB_MAX_RESULTS = 500;
const GREP_MAX_MATCHES = 200;
const GREP_MAX_CANDIDATE_FILES = 5000;
const GREP_MAX_FILE_BYTES = 256 * 1024;
const GREP_LINE_PREVIEW_CHARS = 500;

/**
 * Absolute mount point for the shared scratch directory. Mounted at
 * the same path inside the agent container and every MCP container, so
 * the agent can pass `/scratch/<event-id>/<name>` paths verbatim to
 * MCP tools without translation. See `host/src/Bootstrap.ts` for the
 * host side and the MCP factories for the per-MCP mount.
 */
const SCRATCH_ROOT = "/scratch";

/**
 * Resolve an input path to an absolute path, rejecting empty strings
 * and `..` escapes. Two valid shapes:
 *
 * - **Workspace-relative**: anything that isn't absolute. Resolved
 *   against the workspace root, must stay within it.
 * - **Scratch absolute**: an absolute path under `/scratch/<sub>` —
 *   the shared per-event scratch dir mounted at the same absolute
 *   path in the agent container and in every MCP. Allowed so the
 *   agent reads scratch files with the same path string it passes to
 *   MCP tools; `/scratch` alone (no subdirectory) is rejected to keep
 *   the root inviolable.
 *
 * All other absolute paths are rejected. Centralizes the sandbox check
 * so each tool just calls this once and surfaces the error to the model.
 *
 * @throws {ToolError} If `input` is empty, an absolute path outside
 *   `/scratch/`, or escapes its allowed root via `..`.
 */
function resolveWorkspacePath(input: string): string {
    if (typeof input !== "string") {
        throw new ToolError("BadPath", "path must be a string");
    }
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        throw new ToolError("BadPath", "path must not be empty");
    }
    if (path.isAbsolute(trimmed)) {
        const normalized = path.resolve(trimmed);
        if (normalized === SCRATCH_ROOT) {
            throw new ToolError(
                "BadPath",
                "path must include a subdirectory under /scratch/ (e.g. /scratch/<event-id>/<file>)",
            );
        }
        if (normalized === `${SCRATCH_ROOT}/` || normalized.startsWith(`${SCRATCH_ROOT}/`)) {
            return normalized;
        }
        throw new ToolError(
            "BadPath",
            "absolute paths are only allowed under /scratch/; workspace paths must be relative",
        );
    }
    const root = HandlerFile.getWorkspaceRoot();
    const resolved = path.resolve(root, trimmed);
    const rel = path.relative(root, resolved);
    if (rel === ".." || rel.startsWith(`..${path.sep}`)) {
        throw new ToolError("BadPath", "path escapes workspace root");
    }
    return resolved;
}

/**
 * Operator-configured allowlist of workspace-relative globs
 * (`core.writablePaths`, forwarded as `CORE_WRITABLE_PATHS`). These — plus
 * `/scratch` — are the *only* paths a non-privileged run may write; they
 * are also the curated memory the memory plugin quotes in full. Read once
 * at module load since the env is fixed for the container's lifetime.
 */
const WRITABLE_PATH_GLOBS = getWritablePaths();

/**
 * True when writing this absolute path requires a privileged agentrun.
 *
 * The rule is a single test: **everything is privileged except**
 *
 * - Scratch paths (`/scratch/<event-id>/...`) — per-event ephemeral
 *   storage shared with MCPs, never a handler source.
 * - Paths matching `core.writablePaths` ({@link WRITABLE_PATH_GLOBS}) —
 *   the operator's explicit allowlist of the assistant's own curated
 *   memory (default `wiki/**`, `files/**`), which non-privileged runs
 *   (e.g. a `memory_save` triggered by an inbound mail) must be able to
 *   write.
 *
 * This deliberately replaces the older per-extension scheme (`.md`
 * anywhere / `toolgroups/` privileged, other files free): the same
 * boundary is enforced at the OS layer by directory group-permissions
 * for the `bash` tool, and OS perms are per-directory — so the rule has
 * to be path-scoped, not extension-scoped, for the two enforcers to
 * agree. Files under `core.writablePaths` are never loaded as handlers
 * (see `HandlerFile`/`HandlerCatalog`), so a non-privileged `.md` write
 * there cannot become executable handler logic.
 */
function requiresPrivilegedWrite(absolute: string): boolean {
    if (absolute === SCRATCH_ROOT || absolute.startsWith(`${SCRATCH_ROOT}/`)) {
        return false;
    }
    const root = HandlerFile.getWorkspaceRoot();
    const rel = path.relative(root, absolute);
    return !matchesAnyGlob(WRITABLE_PATH_GLOBS, rel);
}

/** Standardised refusal text used by writing tools when the run is non-privileged. */
const PRIVILEGE_REFUSAL_MESSAGE =
    "This run is non-privileged: it may only write under core.writablePaths " +
    "(the assistant's curated memory, e.g. wiki/** and files/**) and " +
    "/scratch/<event-id>/. Everything else in the workspace — handlers, " +
    "SOUL.md, people/*, toolgroup definitions, and any other file — is " +
    "writable only by privileged runs (those descending from trusted user " +
    "input, e.g. the cli-chat REPL or the operator on Telegram). Reads are " +
    "still allowed everywhere.";

function refusePrivilege(): never {
    throw new ToolError("PrivilegeDenied", PRIVILEGE_REFUSAL_MESSAGE);
}

/**
 * Canonical Unix mode for a freshly written workspace file or created
 * directory. Protected (privilege-required) paths get owner-only write
 * (files `0o640`, dirs setgid `0o2750`); writable paths
 * ({@link requiresPrivilegedWrite} → `false`) get group write (files
 * `0o660`, dirs setgid `0o2770`). The setgid bit keeps the shared
 * `familiar` group on anything created inside a directory, so the
 * `unpriv` user the `bash` tool drops to (same group, different uid)
 * can write group-writable paths but not protected ones.
 *
 * @param absolute Absolute path that was just written/created.
 * @param isDir Whether the path is a directory.
 * @returns The octal mode constant.
 */
function canonicalMode(absolute: string, isDir: boolean): number {
    const isProtected = requiresPrivilegedWrite(absolute);
    if (isDir) {
        return isProtected ? 0o2750 : 0o2770;
    }
    return isProtected ? 0o640 : 0o660;
}

/**
 * Apply {@link canonicalMode} to a path the agent just wrote. The agent
 * process runs as the `priv` user whose primary group is `familiar`, so
 * only the mode needs setting — never owner or group (setgid parents
 * propagate the group). Best-effort by design: the target may already be
 * owned by the `unpriv` bash user (only its owner or root can chmod it),
 * in which case the boot / post-bash {@link PermissionNormalizer} (run as
 * root) re-pins it. Only the expected ownership / missing-file errno
 * values are tolerated; anything else is surfaced.
 *
 * @param absolute Absolute path that was just written/created.
 * @param isDir Whether the path is a directory.
 * @throws Re-throws any chmod error other than EPERM/EACCES/ENOENT.
 */
async function applyCanonicalMode(absolute: string, isDir: boolean): Promise<void> {
    try {
        await fs.chmod(absolute, canonicalMode(absolute, isDir));
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "ENOENT") {
            throw err;
        }
    }
}

interface FileReadInput {
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
}

/**
 * Conservative upper bound on the header text the body prepends to the
 * file content. The header looks like
 * `<file: <path>, bytes <A>-<B> of <TOTAL>, truncated>\n`; long
 * workspace paths plus 8-digit byte counts come in well under this
 * value. Reserving a generous overhead means we can pre-cap the
 * content slice such that `header + content` always fits `ctx.limit`,
 * which is the load-bearing invariant that prevents the offload
 * wrapper from ever firing for `fs_read` (and thus prevents the
 * fs_read→offload→fs_read→… loop).
 */
const FILE_READ_HEADER_OVERHEAD = 200;

/**
 * Build the `fs_read` tool — text-mode and paginated. Returns the
 * raw UTF-8 file content (no JSON wrapping) preceded by a single
 * header line that names the file, the inclusive 1-based byte range
 * returned, the file's total byte size, and whether the response is
 * truncated. Pre-caps the chunk so the total output always fits
 * `ctx.limit`; consequently bypasses {@link runJsonTool} /
 * {@link runTextTool} entirely — wrapping with either would re-spill
 * an oversized result and reintroduce the offload loop the pagination
 * exists to prevent.
 *
 * Header shapes:
 *   `<file: <path>, bytes <A>-<B> of <TOTAL>[, truncated]>`
 *   `<file: <path>, empty>`
 *   `<file: <path>, offset <N> past end of <TOTAL> bytes>`
 *
 * The trailing `, truncated` clause invites the agent to request the
 * next chunk via `offset: <B + 1>`. Multi-byte UTF-8 characters at the
 * natural cut boundary are kept whole.
 */
function buildFsReadTool(ctx: ToolRunContext): Tool<FileReadInput, string> {
    return tool<FileReadInput, string>({
        description:
            "Read a chunk of a file as UTF-8. Paths are workspace-relative " +
            "(`SOUL.md`, `people/anna.md`); absolute paths under " +
            "`/scratch/<event-id>/...` are also accepted, for per-event files " +
            "(e.g. mail attachments, offloaded tool results) shared with MCP " +
            "tools. Returns a header line of the form " +
            "`<file: PATH, bytes A-B of TOTAL[, truncated]>` followed by a " +
            "newline and the raw file content. When the header ends in " +
            "`, truncated`, call again with `offset: <B + 1>` to read the " +
            "next chunk. For searching very large files (e.g. offloaded tool " +
            "results), prefer `fs_grep` over walking the file with `fs_read`.",
        inputSchema: jsonSchema<FileReadInput>({
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: {
                path: {
                    type: "string",
                    description:
                        "Workspace-relative path or absolute path under " +
                        "`/scratch/<event-id>/...` to the file to read.",
                },
                offset: {
                    type: "integer",
                    minimum: 1,
                    description:
                        "1-based byte offset of the first byte to read. Defaults to 1. To " +
                        "continue after a truncated chunk reporting `bytes A-B of TOTAL`, " +
                        "pass `offset: B + 1`.",
                },
                limit: {
                    type: "integer",
                    minimum: 1,
                    description:
                        "Maximum bytes of file content to return in this call. Defaults to " +
                        "whatever fits the inline tool-call budget. The actual returned " +
                        "chunk may be slightly smaller if the natural cut would split a " +
                        "multi-byte UTF-8 character.",
                },
            },
        }),
        execute: async (params) => {
            const p = params.path;
            const offset1 = Math.max(1, params.offset ?? 1);
            const absolute = resolveWorkspacePath(p);

            let stat: Awaited<ReturnType<typeof fs.stat>>;
            try {
                stat = await fs.stat(absolute);
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === "ENOENT") {
                    throw new ToolError("FileNotFound", `file not found: ${p}`);
                }
                throw err;
            }
            if (stat.isDirectory()) {
                throw new ToolError("IsADirectory", `path is a directory, not a file: ${p}`);
            }
            if (!stat.isFile()) {
                throw new ToolError("BadPath", `path is not a regular file: ${p}`);
            }

            const totalBytes = stat.size;
            if (totalBytes === 0) {
                return `<file: ${p}, empty>\n`;
            }
            if (offset1 > totalBytes) {
                return `<file: ${p}, offset ${offset1} past end of ${totalBytes} bytes>\n`;
            }

            const contentBudget = Math.max(1, ctx.limit - FILE_READ_HEADER_OVERHEAD);
            const requested =
                params.limit !== undefined
                    ? Math.max(1, Math.min(params.limit, contentBudget))
                    : contentBudget;

            const startByte0 = offset1 - 1;
            const remaining = totalBytes - startByte0;
            // Read a few extra bytes so the UTF-8 truncation always has
            // the partial trailing code point in hand.
            const toRead = Math.min(remaining, requested + 4);

            const handle = await fs.open(absolute, "r");
            let raw: Buffer;
            try {
                const buf = Buffer.alloc(toRead);
                const { bytesRead } = await handle.read(buf, 0, toRead, startByte0);
                raw = buf.subarray(0, bytesRead);
            } finally {
                await handle.close();
            }

            const decoded = raw.toString("utf8");
            const content = truncateUtf8(decoded, requested);
            const bytesReturned = Buffer.byteLength(content, "utf8");

            const lastByte1 = offset1 + bytesReturned - 1;
            const truncated = startByte0 + bytesReturned < totalBytes;
            const header =
                `<file: ${p}, bytes ${offset1}-${lastByte1} of ${totalBytes}` +
                `${truncated ? ", truncated" : ""}>\n`;

            return header + content;
        },
    });
}

interface FileWriteInput {
    readonly path: string;
    readonly content: string;
}

/**
 * Build the `fs_write` tool. Overwrites the file at `path` with
 * `content`. Creates missing parent directories. Non-privileged runs may
 * only write under `core.writablePaths` and `/scratch`.
 */
function buildFsWriteTool(parent: AgentRunRow, ctx: ToolRunContext): Tool<FileWriteInput, object> {
    return tool<FileWriteInput, object>({
        description:
            "Write or overwrite a file with the given content. Creates missing " +
            "parent directories. Non-privileged runs may only write under " +
            "core.writablePaths (e.g. wiki/**, files/**) and /scratch.",
        inputSchema: jsonSchema<FileWriteInput>({
            type: "object",
            additionalProperties: false,
            required: ["path", "content"],
            properties: {
                path: {
                    type: "string",
                    description: "Workspace-relative path to write. Will be created if missing.",
                },
                content: {
                    type: "string",
                    description: "The full UTF-8 content to write.",
                },
            },
        }),
        execute: ({ path: p, content }) =>
            runJsonTool(async () => {
                const absolute = resolveWorkspacePath(p);
                if (requiresPrivilegedWrite(absolute) && !parent.privileged) {
                    refusePrivilege();
                }
                await fs.mkdir(path.dirname(absolute), { recursive: true });
                await fs.writeFile(absolute, content, "utf8");
                await applyCanonicalMode(absolute, false);
                return { bytes: Buffer.byteLength(content, "utf8") };
            }, ctx),
    });
}

interface FileStrReplaceInput {
    readonly path: string;
    readonly old_string: string;
    readonly new_string: string;
}

/**
 * Build the `fs_str_replace` tool. Replaces exactly one occurrence
 * of `old_string` with `new_string`. Errors if `old_string` is not
 * found, or appears more than once (in which case the model is told
 * to add surrounding context to disambiguate). Non-privileged runs may
 * only write under `core.writablePaths` and `/scratch`.
 */
function buildFsStrReplaceTool(
    parent: AgentRunRow,
    ctx: ToolRunContext,
): Tool<FileStrReplaceInput, object> {
    return tool<FileStrReplaceInput, object>({
        description:
            "Replace exactly one occurrence of `old_string` with `new_string` " +
            "in the file. Errors if `old_string` is missing or appears more " +
            "than once — in the multi-match case, add surrounding context to " +
            "make the match unique. Non-privileged runs may only write under " +
            "core.writablePaths (e.g. wiki/**, files/**) and /scratch.",
        inputSchema: jsonSchema<FileStrReplaceInput>({
            type: "object",
            additionalProperties: false,
            required: ["path", "old_string", "new_string"],
            properties: {
                path: {
                    type: "string",
                    description: "Workspace-relative path of the file to edit.",
                },
                old_string: {
                    type: "string",
                    description: "Exact substring to find. Must occur exactly once in the file.",
                },
                new_string: {
                    type: "string",
                    description: "Replacement text. May be empty to delete the match.",
                },
            },
        }),
        execute: ({ path: p, old_string, new_string }) =>
            runJsonTool(async () => {
                const absolute = resolveWorkspacePath(p);
                if (requiresPrivilegedWrite(absolute) && !parent.privileged) {
                    refusePrivilege();
                }
                if (typeof old_string !== "string" || old_string.length === 0) {
                    throw new ToolError("BadInput", "old_string must be non-empty");
                }

                let content: string;
                try {
                    content = await fs.readFile(absolute, "utf8");
                } catch (err) {
                    const code = (err as NodeJS.ErrnoException).code;
                    if (code === "ENOENT") {
                        throw new ToolError("FileNotFound", `file not found: ${p}`);
                    }
                    throw err;
                }

                const first = content.indexOf(old_string);
                if (first === -1) {
                    throw new ToolError("NoMatch", "old_string not found in file");
                }
                const second = content.indexOf(old_string, first + old_string.length);
                if (second !== -1) {
                    throw new ToolError(
                        "AmbiguousMatch",
                        "old_string occurs more than once. " +
                            "Add surrounding context to make the match unique.",
                    );
                }

                const updated =
                    content.slice(0, first) + new_string + content.slice(first + old_string.length);
                await fs.writeFile(absolute, updated, "utf8");
                await applyCanonicalMode(absolute, false);
                return {};
            }, ctx),
    });
}

interface FileAppendInput {
    readonly path: string;
    readonly content: string;
}

/**
 * Build the `fs_append` tool. Appends `content` to the file at
 * `path`, creating the file (and parent directories) if missing.
 *
 * If the existing file is non-empty and doesn't end with a newline,
 * a `\n` is inserted before the appended content. Models reliably
 * call `fs_append` thinking of it as "add a new line" rather than
 * "concatenate bytes", so this matches the natural mental model and
 * avoids accidentally gluing two records onto the same line. Files
 * that already end with `\n` are left alone (no double newlines).
 *
 * Non-privileged runs may only write under `core.writablePaths` and `/scratch`.
 */
function buildFsAppendTool(
    parent: AgentRunRow,
    ctx: ToolRunContext,
): Tool<FileAppendInput, object> {
    return tool<FileAppendInput, object>({
        description:
            "Append content to the end of a file. Creates the file (and any " +
            "missing parent directories) if it does not exist. If the existing " +
            "file is non-empty and doesn't already end with a newline, one is " +
            "inserted before your content — so each call adds a new line. " +
            "Non-privileged runs may only write under core.writablePaths " +
            "(e.g. wiki/**, files/**) and /scratch.",
        inputSchema: jsonSchema<FileAppendInput>({
            type: "object",
            additionalProperties: false,
            required: ["path", "content"],
            properties: {
                path: {
                    type: "string",
                    description: "Workspace-relative path. Created if missing.",
                },
                content: {
                    type: "string",
                    description:
                        "Text to append. A leading newline is added automatically " +
                        "when the existing file is non-empty and doesn't end with " +
                        "one, so you don't need to pad your content yourself.",
                },
            },
        }),
        execute: ({ path: p, content }) =>
            runJsonTool(async () => {
                const absolute = resolveWorkspacePath(p);
                if (requiresPrivilegedWrite(absolute) && !parent.privileged) {
                    refusePrivilege();
                }
                await fs.mkdir(path.dirname(absolute), { recursive: true });
                const prefix = (await needsLeadingNewline(absolute)) ? "\n" : "";
                const toWrite = prefix + content;
                await fs.appendFile(absolute, toWrite, "utf8");
                await applyCanonicalMode(absolute, false);
                return { bytes: Buffer.byteLength(toWrite, "utf8") };
            }, ctx),
    });
}

/**
 * Decide whether `fs_append` should prepend a `\n` before its
 * payload. True only when the file already exists, has at least one
 * byte, and its last byte isn't `\n`. Missing-file is the common
 * case (creates fresh) and needs no prefix.
 */
async function needsLeadingNewline(absolute: string): Promise<boolean> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
        stat = await fs.stat(absolute);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
            return false;
        }
        throw err;
    }
    if (stat.size === 0) {
        return false;
    }
    const fh = await fs.open(absolute, "r");
    try {
        const buf = Buffer.alloc(1);
        await fh.read(buf, 0, 1, stat.size - 1);
        return buf[0] !== 0x0a;
    } finally {
        await fh.close();
    }
}

interface LsInput {
    readonly path: string;
}

/**
 * Build the `ls` tool. Lists immediate entries (files + subdirectories)
 * of a workspace directory. Pass `.` for the workspace root.
 */
function buildLsTool(ctx: ToolRunContext): Tool<LsInput, object> {
    return tool<LsInput, object>({
        description:
            "List immediate entries of a workspace directory (non-recursive). " +
            "Pass `.` for the workspace root. Returns one entry per child with " +
            "its name and type (`file` / `directory` / `other`).",
        inputSchema: jsonSchema<LsInput>({
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: {
                path: {
                    type: "string",
                    description: "Workspace-relative directory path. Use `.` for the root.",
                },
            },
        }),
        execute: ({ path: p }) =>
            runJsonTool(async () => {
                const absolute = resolveWorkspacePath(p === "" ? "." : p);
                let dirents: import("node:fs").Dirent[];
                try {
                    dirents = await fs.readdir(absolute, { withFileTypes: true });
                } catch (err) {
                    const code = (err as NodeJS.ErrnoException).code;
                    if (code === "ENOENT") {
                        throw new ToolError("NotFound", `directory not found: ${p}`);
                    }
                    if (code === "ENOTDIR") {
                        throw new ToolError("NotADirectory", `path is not a directory: ${p}`);
                    }
                    throw err;
                }
                const entries = dirents.map((d) => ({
                    name: d.name,
                    type: d.isFile() ? "file" : d.isDirectory() ? "directory" : "other",
                }));
                entries.sort((a, b) => a.name.localeCompare(b.name));
                return { entries };
            }, ctx),
    });
}

interface GlobInput {
    readonly pattern: string;
}

/**
 * Build the `glob` tool. Matches workspace files against a glob
 * pattern (e.g. `chat/*.md`, `**\/*.json`) and returns matching
 * workspace-relative paths as JSONL — one `{"path":"..."}` per line,
 * with a terminating `{"truncated":true,...}` marker when the cap is
 * hit. Capped at {@link GLOB_MAX_RESULTS} hits.
 */
function buildGlobTool(ctx: ToolRunContext): Tool<GlobInput, string> {
    return tool<GlobInput, string>({
        description:
            "Match files in the workspace against a glob pattern (e.g. " +
            "`chat/*.md`, `**/*.json`, `people/*.md`). Returns workspace-" +
            'relative paths as one JSON object per line (`{"path":"..."}`). ' +
            `Capped at ${GLOB_MAX_RESULTS} matches; a trailing ` +
            '`{"truncated":true,...}` line is appended when the cap fires.',
        inputSchema: jsonSchema<GlobInput>({
            type: "object",
            additionalProperties: false,
            required: ["pattern"],
            properties: {
                pattern: {
                    type: "string",
                    description: "Glob pattern, relative to the workspace root.",
                },
            },
        }),
        execute: ({ pattern }) =>
            runJsonLinesTool(async () => {
                const root = HandlerFile.getWorkspaceRoot();
                const paths: string[] = [];
                let capped = false;
                for await (const match of fs.glob(pattern, { cwd: root })) {
                    paths.push(match);
                    if (paths.length >= GLOB_MAX_RESULTS) {
                        capped = true;
                        break;
                    }
                }
                paths.sort();
                const out: object[] = paths.map((p) => ({ path: p }));
                if (capped) {
                    out.push({
                        truncated: true,
                        cappedAt: GLOB_MAX_RESULTS,
                        reason: `glob hit ${GLOB_MAX_RESULTS}-result ceiling; narrow the pattern for completeness`,
                    });
                }
                return out;
            }, ctx),
    });
}

interface GrepInput {
    readonly pattern: string;
    readonly path?: string;
    readonly glob?: string;
}

interface GrepMatch {
    readonly file: string;
    readonly line: number;
    readonly text: string;
}

/**
 * Build the `grep` tool. Searches workspace files for a JavaScript
 * regex. Optional `path` (file or subdirectory; default: workspace
 * root) narrows the scan; optional `glob` further filters which files
 * inside that subtree are inspected. Returns up to
 * {@link GREP_MAX_MATCHES} matches as JSONL, plus a `{"truncated":true,
 * ...}` marker line when the cap fires.
 */
function buildGrepTool(ctx: ToolRunContext): Tool<GrepInput, string> {
    return tool<GrepInput, string>({
        description:
            "Search workspace files for a regex pattern (JavaScript regex syntax). " +
            "Optional `path` (file or subdirectory; default: workspace root) " +
            "narrows the scan; optional `glob` (e.g. `**/*.md`) further filters " +
            `which files are inspected. Returns up to ${GREP_MAX_MATCHES} matches ` +
            'as one JSON object per line (`{"file":..., "line":..., "text":...}`).',
        inputSchema: jsonSchema<GrepInput>({
            type: "object",
            additionalProperties: false,
            required: ["pattern"],
            properties: {
                pattern: {
                    type: "string",
                    description:
                        "JavaScript regex source (no surrounding slashes). Example: `^# `.",
                },
                path: {
                    type: "string",
                    description:
                        "Workspace-relative file or directory to search. Default: workspace root.",
                },
                glob: {
                    type: "string",
                    description:
                        "Optional glob filter, applied relative to `path` " +
                        "(e.g. `**/*.md`). Default: every file under `path`.",
                },
            },
        }),
        execute: ({ pattern, path: searchPath, glob: globPattern }) =>
            runJsonLinesTool(async () => {
                let regex: RegExp;
                try {
                    regex = new RegExp(pattern);
                } catch (err) {
                    throw new ToolError(
                        "BadRegex",
                        `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }

                const root = HandlerFile.getWorkspaceRoot();
                const baseAbs = resolveWorkspacePath(searchPath ?? ".");

                let baseStat: Awaited<ReturnType<typeof fs.stat>>;
                try {
                    baseStat = await fs.stat(baseAbs);
                } catch (err) {
                    const code = (err as NodeJS.ErrnoException).code;
                    if (code === "ENOENT") {
                        throw new ToolError("NotFound", `path not found: ${searchPath ?? "."}`);
                    }
                    throw err;
                }

                const candidates: string[] = [];
                if (baseStat.isFile()) {
                    candidates.push(baseAbs);
                } else if (baseStat.isDirectory()) {
                    const pat = globPattern ?? "**/*";
                    for await (const dirent of fs.glob(pat, {
                        cwd: baseAbs,
                        withFileTypes: true,
                    })) {
                        if (dirent.isFile()) {
                            candidates.push(path.join(dirent.parentPath, dirent.name));
                        }
                        if (candidates.length >= GREP_MAX_CANDIDATE_FILES) {
                            break;
                        }
                    }
                } else {
                    throw new ToolError(
                        "BadPath",
                        `path is neither a file nor a directory: ${searchPath ?? "."}`,
                    );
                }

                const matches: GrepMatch[] = [];
                let capped = false;
                for (const file of candidates) {
                    if (matches.length >= GREP_MAX_MATCHES) {
                        capped = true;
                        break;
                    }
                    let stat: Awaited<ReturnType<typeof fs.stat>>;
                    try {
                        stat = await fs.stat(file);
                    } catch {
                        continue;
                    }
                    if (stat.size > GREP_MAX_FILE_BYTES) {
                        continue;
                    }
                    let content: string;
                    try {
                        content = await fs.readFile(file, "utf8");
                    } catch {
                        continue;
                    }
                    const lines = content.split("\n");
                    for (let i = 0; i < lines.length; i++) {
                        if (regex.test(lines[i])) {
                            matches.push({
                                file: path.relative(root, file),
                                line: i + 1,
                                text: lines[i].slice(0, GREP_LINE_PREVIEW_CHARS),
                            });
                            if (matches.length >= GREP_MAX_MATCHES) {
                                capped = true;
                                break;
                            }
                        }
                    }
                }
                const out: object[] = matches.slice();
                if (capped) {
                    out.push({
                        truncated: true,
                        cappedAt: GREP_MAX_MATCHES,
                        reason: `grep hit ${GREP_MAX_MATCHES}-match ceiling; narrow the search for completeness`,
                    });
                }
                return out;
            }, ctx),
    });
}

interface FsRemoveInput {
    readonly path: string;
}

interface FsRemoveSkip {
    readonly path: string;
    readonly reason: string;
}

/**
 * Glob meta characters that mark a path segment as a pattern rather
 * than a literal. `**` is checked separately as a substring.
 */
const GLOB_META = /[*?[]/;

/**
 * Decide whether a workspace-relative input is a glob pattern *and*
 * confined to the basename. Returns:
 *
 * - `{ kind: "literal" }` — no wildcards anywhere; treat as a single
 *   path and `unlink` it directly.
 * - `{ kind: "wildcard" }` — wildcards present only in the last
 *   segment, no `**` anywhere; safe to expand with `fs.glob` without
 *   recursing into subdirectories.
 * - `{ kind: "invalid", error }` — wildcards in a non-last segment, or
 *   `**` anywhere; rejected with a message the model can act on.
 *
 * Splitting is done on the *original* input string before path
 * resolution because `path.resolve` collapses segments and would hide
 * a `chat/*\/foo.txt`-style escape.
 */
function classifyRemovePattern(
    input: string,
): { kind: "literal" } | { kind: "wildcard" } | { kind: "invalid"; error: string } {
    if (input.includes("**")) {
        return {
            kind: "invalid",
            error: "recursive globs (`**`) are not allowed; fs_remove only matches files in one directory",
        };
    }
    const segments = input.split("/");
    const lastIndex = segments.length - 1;
    for (let i = 0; i < lastIndex; i++) {
        if (GLOB_META.test(segments[i])) {
            return {
                kind: "invalid",
                error: "wildcards are only allowed in the file basename, not in directory segments",
            };
        }
    }
    return GLOB_META.test(segments[lastIndex]) ? { kind: "wildcard" } : { kind: "literal" };
}

/**
 * Build the `fs_remove` tool. Removes a single file (literal path) or
 * every file matching a basename-scoped glob (e.g. `chat/digests/*.jsonl`).
 *
 * Hard constraints — enforced by {@link classifyRemovePattern}:
 *
 * - Never deletes directories. A literal directory path errors out; a
 *   wildcard that happens to match a subdirectory entry skips it with a
 *   reason instead of failing the whole call.
 * - No recursion. `**` is rejected outright and dirname segments may
 *   not contain glob meta, so an expansion can only touch files in one
 *   literal directory.
 * - Privilege gate. `.md` files and anything under `workspace/toolgroups/`
 *   require a privileged run, exactly matching `fs_write` / `fs_append`.
 *   In the wildcard branch, gated matches are skipped (so a cleanup over
 *   a mixed directory still removes what it's allowed to); in the literal
 *   branch, a gated target fails the call so the model gets an explicit
 *   refusal.
 */
function buildFsRemoveTool(parent: AgentRunRow, ctx: ToolRunContext): Tool<FsRemoveInput, object> {
    return tool<FsRemoveInput, object>({
        description:
            "Remove a file from the workspace. The `path` may be a single " +
            "workspace-relative file (e.g. `chat/digests/2026-05.jsonl`), or " +
            "a glob whose wildcards are confined to the basename (e.g. " +
            "`chat/digests/*.jsonl`). Directory segments must be literal; `**` " +
            "is rejected. Never deletes directories — a directory match is " +
            "skipped (wildcard branch) or rejected (literal branch). Non-privileged " +
            "runs may only delete under core.writablePaths (e.g. wiki/**, files/**) " +
            "and /scratch, same as `fs_write`. Scratch paths " +
            "(`/scratch/<event-id>/...`) are accepted for per-event cleanup.",
        inputSchema: jsonSchema<FsRemoveInput>({
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: {
                path: {
                    type: "string",
                    description:
                        "Workspace-relative file path or basename-scoped glob. " +
                        "Wildcards (`*`, `?`, `[...]`) allowed only in the last " +
                        "segment; `**` and wildcards in directory segments are rejected.",
                },
            },
        }),
        execute: ({ path: p }) =>
            runJsonTool(async () => {
                const classification = classifyRemovePattern(p);
                if (classification.kind === "invalid") {
                    throw new ToolError("BadPattern", classification.error);
                }

                const absolute = resolveWorkspacePath(p);

                if (classification.kind === "literal") {
                    if (requiresPrivilegedWrite(absolute) && !parent.privileged) {
                        refusePrivilege();
                    }
                    let stat: Awaited<ReturnType<typeof fs.lstat>>;
                    try {
                        stat = await fs.lstat(absolute);
                    } catch (err) {
                        const code = (err as NodeJS.ErrnoException).code;
                        if (code === "ENOENT") {
                            throw new ToolError("FileNotFound", `file not found: ${p}`);
                        }
                        throw err;
                    }
                    if (stat.isDirectory()) {
                        throw new ToolError(
                            "IsADirectory",
                            `path is a directory; fs_remove does not delete directories: ${p}`,
                        );
                    }
                    await fs.unlink(absolute);
                    return { removed: [p], skipped: [] };
                }

                const root = HandlerFile.getWorkspaceRoot();
                const isAbsolutePattern = path.isAbsolute(p.trim());
                const globCwd = isAbsolutePattern ? "/" : root;
                const removed: string[] = [];
                const skipped: FsRemoveSkip[] = [];

                for await (const dirent of fs.glob(p, { cwd: globCwd, withFileTypes: true })) {
                    const matchAbs = path.join(dirent.parentPath, dirent.name);
                    const matchRel = isAbsolutePattern ? matchAbs : path.relative(root, matchAbs);
                    if (!dirent.isFile()) {
                        skipped.push({
                            path: matchRel,
                            reason: dirent.isDirectory()
                                ? "is a directory"
                                : "is not a regular file",
                        });
                        continue;
                    }
                    if (requiresPrivilegedWrite(matchAbs) && !parent.privileged) {
                        skipped.push({ path: matchRel, reason: PRIVILEGE_REFUSAL_MESSAGE });
                        continue;
                    }
                    try {
                        await fs.unlink(matchAbs);
                        removed.push(matchRel);
                    } catch (err) {
                        skipped.push({
                            path: matchRel,
                            reason: err instanceof Error ? err.message : String(err),
                        });
                    }
                }

                removed.sort();
                skipped.sort((a, b) => a.path.localeCompare(b.path));
                return { removed, skipped };
            }, ctx),
    });
}

/**
 * Bundle all filesystem-shaped tools for one agentrun. The writing
 * tools (`fs_write`, `fs_str_replace`, `fs_append`, `fs_remove`)
 * close over `parent.privileged` so the writablePaths privilege gate is
 * decided once at registration time and the model's tool calls can't
 * bypass it.
 */
export function buildFsTools(parent: AgentRunRow, ctx: ToolRunContext): ToolSet {
    return {
        fs_read: buildFsReadTool(ctx),
        fs_write: buildFsWriteTool(parent, ctx),
        fs_str_replace: buildFsStrReplaceTool(parent, ctx),
        fs_append: buildFsAppendTool(parent, ctx),
        fs_ls: buildLsTool(ctx),
        fs_glob: buildGlobTool(ctx),
        fs_grep: buildGrepTool(ctx),
        fs_remove: buildFsRemoveTool(parent, ctx),
    };
}
