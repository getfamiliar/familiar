import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunRow } from "@getfamiliar/shared";
import type { Tool, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
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
 * @throws If `input` is empty, an absolute path outside `/scratch/`,
 *   or escapes its allowed root via `..`.
 */
function resolveWorkspacePath(input: string): string {
    if (typeof input !== "string") {
        throw new Error("path must be a string");
    }
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        throw new Error("path must not be empty");
    }
    if (path.isAbsolute(trimmed)) {
        const normalized = path.resolve(trimmed);
        if (normalized === SCRATCH_ROOT) {
            throw new Error(
                "path must include a subdirectory under /scratch/ (e.g. /scratch/<event-id>/<file>)",
            );
        }
        if (normalized === `${SCRATCH_ROOT}/` || normalized.startsWith(`${SCRATCH_ROOT}/`)) {
            return normalized;
        }
        throw new Error(
            "absolute paths are only allowed under /scratch/; workspace paths must be relative",
        );
    }
    const root = HandlerFile.getWorkspaceRoot();
    const resolved = path.resolve(root, trimmed);
    const rel = path.relative(root, resolved);
    if (rel === "..") {
        throw new Error("path escapes workspace root");
    }
    if (rel.startsWith(`..${path.sep}`)) {
        throw new Error("path escapes workspace root");
    }
    return resolved;
}

/** Workspace-relative directory whose contents are gated regardless of extension. */
const TOOLGROUPS_DIR = "toolgroups";

/**
 * True when writing this absolute path requires a privileged
 * agentrun. Two cases:
 *
 * - `.md` anywhere in the workspace — handlers, SOUL.md, people notes, etc.
 * - Anything (any extension) under `workspace/toolgroups/` — those
 *   files declare which MCP tools handlers may use, so widening
 *   them is privilege escalation in spirit.
 *
 * Scratch paths (`/scratch/<event-id>/...`) bypass both checks: scratch
 * is per-event ephemeral storage shared with MCPs, never a handler
 * source, and the privilege gate would only get in the way of
 * legitimate work (e.g. saving an intermediate `.md` artifact for a
 * child agentrun to read).
 */
function requiresPrivilegedWrite(absolute: string): boolean {
    if (absolute === SCRATCH_ROOT || absolute.startsWith(`${SCRATCH_ROOT}/`)) {
        return false;
    }
    if (absolute.toLowerCase().endsWith(".md")) {
        return true;
    }
    const root = HandlerFile.getWorkspaceRoot();
    const rel = path.relative(root, absolute);
    if (rel === TOOLGROUPS_DIR) {
        return true;
    }
    if (rel.startsWith(`${TOOLGROUPS_DIR}${path.sep}`)) {
        return true;
    }
    return false;
}

/**
 * Standard refusal returned by writing tools when the agentrun is
 * non-privileged and the target is a gated path. The text spells out
 * *why* so the model can decide what to do (give up, ask the user,
 * write a different file) instead of looping retries.
 */
function privilegeRefusal(): { readonly ok: false; readonly error: string } {
    return {
        ok: false,
        error:
            "Only privileged agentruns may write to .md files or anything under " +
            "workspace/toolgroups/. This run is non-privileged. Those files " +
            "(handlers, SOUL.md, people/*, toolgroup definitions) can only be " +
            "modified by runs descending from trusted user input (cli-chat REPL " +
            "or the operator on Telegram). Reads are still allowed.",
    };
}

interface FileReadInput {
    readonly path: string;
}

type FileReadOutput =
    | { readonly ok: true; readonly content: string; readonly totalLines: number }
    | { readonly ok: false; readonly error: string };

/**
 * Build the `file_read` tool. Reads a workspace file as UTF-8 and
 * returns its full contents. Stripped to a single `path` property
 * while we shake out tool-call reliability — slicing via offset/limit
 * can come back once the simple shape is reliable.
 */
function buildFileReadTool(): Tool<FileReadInput, FileReadOutput> {
    return tool<FileReadInput, FileReadOutput>({
        description:
            "Read a file and return its UTF-8 contents. Paths are workspace-" +
            "relative (e.g. `SOUL.md`, `people/anna.md`) — except absolute " +
            "paths under `/scratch/<event-id>/...` are also accepted, for per-" +
            "event files (e.g. mail attachments) shared with MCP tools.",
        inputSchema: jsonSchema<FileReadInput>({
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: {
                path: {
                    type: "string",
                    description: "Workspace-relative path to the file to read.",
                },
            },
        }),
        execute: async (params) => {
            const p = params.path;
            let absolute: string;
            try {
                absolute = resolveWorkspacePath(p);
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }

            let content: string;
            try {
                content = await fs.readFile(absolute, "utf8");
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === "ENOENT") {
                    return { ok: false, error: `file not found: ${p}` };
                }
                if (code === "EISDIR") {
                    return { ok: false, error: `path is a directory, not a file: ${p}` };
                }
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }

            const totalLines = content.split("\n").length;
            return { ok: true, content, totalLines };
        },
    });
}

interface FileWriteInput {
    readonly path: string;
    readonly content: string;
}

type FileWriteOutput =
    | { readonly ok: true; readonly bytes: number }
    | { readonly ok: false; readonly error: string };

/**
 * Build the `file_write` tool. Overwrites the file at `path` with
 * `content`. Creates missing parent directories. Refuses `.md` writes
 * for non-privileged runs.
 */
function buildFileWriteTool(parent: AgentRunRow): Tool<FileWriteInput, FileWriteOutput> {
    return tool<FileWriteInput, FileWriteOutput>({
        description:
            "Write or overwrite a file with the given content. Creates missing " +
            "parent directories. Markdown (.md) writes require a privileged run.",
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
        execute: async ({ path: p, content }) => {
            let absolute: string;
            try {
                absolute = resolveWorkspacePath(p);
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
            if (requiresPrivilegedWrite(absolute) && !parent.privileged) {
                return privilegeRefusal();
            }
            try {
                await fs.mkdir(path.dirname(absolute), { recursive: true });
                await fs.writeFile(absolute, content, "utf8");
                return { ok: true, bytes: Buffer.byteLength(content, "utf8") };
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
    });
}

interface FileStrReplaceInput {
    readonly path: string;
    readonly old_string: string;
    readonly new_string: string;
}

type FileStrReplaceOutput = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Build the `file_str_replace` tool. Replaces exactly one occurrence
 * of `old_string` with `new_string`. Errors if `old_string` is not
 * found, or appears more than once (in which case the model is told
 * to add surrounding context to disambiguate). Refuses `.md` writes
 * for non-privileged runs.
 */
function buildFileStrReplaceTool(
    parent: AgentRunRow,
): Tool<FileStrReplaceInput, FileStrReplaceOutput> {
    return tool<FileStrReplaceInput, FileStrReplaceOutput>({
        description:
            "Replace exactly one occurrence of `old_string` with `new_string` " +
            "in the file. Errors if `old_string` is missing or appears more " +
            "than once — in the multi-match case, add surrounding context to " +
            "make the match unique. Markdown (.md) writes require a privileged run.",
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
        execute: async ({ path: p, old_string, new_string }) => {
            let absolute: string;
            try {
                absolute = resolveWorkspacePath(p);
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
            if (requiresPrivilegedWrite(absolute) && !parent.privileged) {
                return privilegeRefusal();
            }
            if (typeof old_string !== "string" || old_string.length === 0) {
                return { ok: false, error: "old_string must be non-empty" };
            }

            let content: string;
            try {
                content = await fs.readFile(absolute, "utf8");
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === "ENOENT") {
                    return { ok: false, error: `file not found: ${p}` };
                }
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }

            const first = content.indexOf(old_string);
            if (first === -1) {
                return { ok: false, error: "old_string not found in file" };
            }
            const second = content.indexOf(old_string, first + old_string.length);
            if (second !== -1) {
                return {
                    ok: false,
                    error:
                        "old_string occurs more than once. " +
                        "Add surrounding context to make the match unique.",
                };
            }

            const updated =
                content.slice(0, first) + new_string + content.slice(first + old_string.length);
            try {
                await fs.writeFile(absolute, updated, "utf8");
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
            return { ok: true };
        },
    });
}

interface FileAppendInput {
    readonly path: string;
    readonly content: string;
}

type FileAppendOutput =
    | { readonly ok: true; readonly bytes: number }
    | { readonly ok: false; readonly error: string };

/**
 * Build the `file_append` tool. Appends `content` to the file at
 * `path`, creating the file (and parent directories) if missing.
 *
 * If the existing file is non-empty and doesn't end with a newline,
 * a `\n` is inserted before the appended content. Models reliably
 * call `file_append` thinking of it as "add a new line" rather than
 * "concatenate bytes", so this matches the natural mental model and
 * avoids accidentally gluing two records onto the same line. Files
 * that already end with `\n` are left alone (no double newlines).
 *
 * Refuses `.md` and `toolgroups/*` writes for non-privileged runs.
 */
function buildFileAppendTool(parent: AgentRunRow): Tool<FileAppendInput, FileAppendOutput> {
    return tool<FileAppendInput, FileAppendOutput>({
        description:
            "Append content to the end of a file. Creates the file (and any " +
            "missing parent directories) if it does not exist. If the existing " +
            "file is non-empty and doesn't already end with a newline, one is " +
            "inserted before your content — so each call adds a new line. " +
            "Markdown (.md) appends require a privileged run.",
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
        execute: async ({ path: p, content }) => {
            let absolute: string;
            try {
                absolute = resolveWorkspacePath(p);
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
            if (requiresPrivilegedWrite(absolute) && !parent.privileged) {
                return privilegeRefusal();
            }
            try {
                await fs.mkdir(path.dirname(absolute), { recursive: true });
                const prefix = (await needsLeadingNewline(absolute)) ? "\n" : "";
                const toWrite = prefix + content;
                await fs.appendFile(absolute, toWrite, "utf8");
                return { ok: true, bytes: Buffer.byteLength(toWrite, "utf8") };
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
    });
}

/**
 * Decide whether `file_append` should prepend a `\n` before its
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

interface LsEntry {
    readonly name: string;
    readonly type: "file" | "directory" | "other";
}

type LsOutput =
    | { readonly ok: true; readonly entries: readonly LsEntry[] }
    | { readonly ok: false; readonly error: string };

/**
 * Build the `ls` tool. Lists immediate entries (files + subdirectories)
 * of a workspace directory. Pass `.` for the workspace root.
 */
function buildLsTool(): Tool<LsInput, LsOutput> {
    return tool<LsInput, LsOutput>({
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
        execute: async ({ path: p }) => {
            let absolute: string;
            try {
                absolute = resolveWorkspacePath(p === "" ? "." : p);
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
            try {
                const dirents = await fs.readdir(absolute, { withFileTypes: true });
                const entries: LsEntry[] = dirents.map((d) => ({
                    name: d.name,
                    type: d.isFile() ? "file" : d.isDirectory() ? "directory" : "other",
                }));
                entries.sort((a, b) => a.name.localeCompare(b.name));
                return { ok: true, entries };
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === "ENOENT") {
                    return { ok: false, error: `directory not found: ${p}` };
                }
                if (code === "ENOTDIR") {
                    return { ok: false, error: `path is not a directory: ${p}` };
                }
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
    });
}

interface GlobInput {
    readonly pattern: string;
}

type GlobOutput =
    | { readonly ok: true; readonly paths: readonly string[]; readonly truncated: boolean }
    | { readonly ok: false; readonly error: string };

/**
 * Build the `glob` tool. Matches workspace files against a glob
 * pattern (e.g. `chat/*.md`, `**\/*.json`) and returns matching
 * workspace-relative paths. Capped at {@link GLOB_MAX_RESULTS} hits.
 */
function buildGlobTool(): Tool<GlobInput, GlobOutput> {
    return tool<GlobInput, GlobOutput>({
        description:
            "Match files in the workspace against a glob pattern (e.g. " +
            "`chat/*.md`, `**/*.json`, `people/*.md`). Returns workspace-" +
            `relative paths. Capped at ${GLOB_MAX_RESULTS} matches.`,
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
        execute: async ({ pattern }) => {
            const root = HandlerFile.getWorkspaceRoot();
            const paths: string[] = [];
            let truncated = false;
            try {
                for await (const match of fs.glob(pattern, { cwd: root })) {
                    paths.push(match);
                    if (paths.length >= GLOB_MAX_RESULTS) {
                        truncated = true;
                        break;
                    }
                }
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
            paths.sort();
            return { ok: true, paths, truncated };
        },
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

type GrepOutput =
    | { readonly ok: true; readonly matches: readonly GrepMatch[]; readonly truncated: boolean }
    | { readonly ok: false; readonly error: string };

/**
 * Build the `grep` tool. Searches workspace files for a JavaScript
 * regex. Optional `path` (file or subdirectory; default: workspace
 * root) narrows the scan; optional `glob` further filters which files
 * inside that subtree are inspected. Returns up to
 * {@link GREP_MAX_MATCHES} matches with `truncated` flagged when more
 * exist.
 */
function buildGrepTool(): Tool<GrepInput, GrepOutput> {
    return tool<GrepInput, GrepOutput>({
        description:
            "Search workspace files for a regex pattern (JavaScript regex syntax). " +
            "Optional `path` (file or subdirectory; default: workspace root) " +
            "narrows the scan; optional `glob` (e.g. `**/*.md`) further filters " +
            `which files are inspected. Returns up to ${GREP_MAX_MATCHES} matches.`,
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
        execute: async ({ pattern, path: searchPath, glob: globPattern }) => {
            let regex: RegExp;
            try {
                regex = new RegExp(pattern);
            } catch (err) {
                return {
                    ok: false,
                    error: `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
                };
            }

            const root = HandlerFile.getWorkspaceRoot();
            let baseAbs: string;
            try {
                baseAbs = resolveWorkspacePath(searchPath ?? ".");
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }

            let baseStat: Awaited<ReturnType<typeof fs.stat>>;
            try {
                baseStat = await fs.stat(baseAbs);
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === "ENOENT") {
                    return { ok: false, error: `path not found: ${searchPath ?? "."}` };
                }
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }

            const candidates: string[] = [];
            if (baseStat.isFile()) {
                candidates.push(baseAbs);
            } else if (baseStat.isDirectory()) {
                const pat = globPattern ?? "**/*";
                try {
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
                } catch (err) {
                    return { ok: false, error: err instanceof Error ? err.message : String(err) };
                }
            } else {
                return {
                    ok: false,
                    error: `path is neither a file nor a directory: ${searchPath ?? "."}`,
                };
            }

            const matches: GrepMatch[] = [];
            let truncated = false;
            for (const file of candidates) {
                if (matches.length >= GREP_MAX_MATCHES) {
                    truncated = true;
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
                            truncated = true;
                            break;
                        }
                    }
                }
            }
            return { ok: true, matches, truncated };
        },
    });
}

interface FsRemoveInput {
    readonly path: string;
}

interface FsRemoveSkip {
    readonly path: string;
    readonly reason: string;
}

type FsRemoveOutput =
    | {
          readonly ok: true;
          readonly removed: readonly string[];
          readonly skipped: readonly FsRemoveSkip[];
      }
    | { readonly ok: false; readonly error: string };

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
 *   require a privileged run, exactly matching `file_write` / `file_append`.
 *   In the wildcard branch, gated matches are skipped (so a cleanup over
 *   a mixed directory still removes what it's allowed to); in the literal
 *   branch, a gated target fails the call so the model gets an explicit
 *   refusal.
 */
function buildFsRemoveTool(parent: AgentRunRow): Tool<FsRemoveInput, FsRemoveOutput> {
    return tool<FsRemoveInput, FsRemoveOutput>({
        description:
            "Remove a file from the workspace. The `path` may be a single " +
            "workspace-relative file (e.g. `chat/digests/2026-05.jsonl`), or " +
            "a glob whose wildcards are confined to the basename (e.g. " +
            "`chat/digests/*.jsonl`). Directory segments must be literal; `**` " +
            "is rejected. Never deletes directories — a directory match is " +
            "skipped (wildcard branch) or rejected (literal branch). Markdown " +
            "(.md) deletions and anything under `workspace/toolgroups/` require " +
            "a privileged run, same as `file_write`. Scratch paths " +
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
        execute: async ({ path: p }) => {
            const classification = classifyRemovePattern(p);
            if (classification.kind === "invalid") {
                return { ok: false, error: classification.error };
            }

            let absolute: string;
            try {
                absolute = resolveWorkspacePath(p);
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }

            if (classification.kind === "literal") {
                if (requiresPrivilegedWrite(absolute) && !parent.privileged) {
                    return privilegeRefusal();
                }
                let stat: Awaited<ReturnType<typeof fs.lstat>>;
                try {
                    stat = await fs.lstat(absolute);
                } catch (err) {
                    const code = (err as NodeJS.ErrnoException).code;
                    if (code === "ENOENT") {
                        return { ok: false, error: `file not found: ${p}` };
                    }
                    return { ok: false, error: err instanceof Error ? err.message : String(err) };
                }
                if (stat.isDirectory()) {
                    return {
                        ok: false,
                        error: `path is a directory; fs_remove does not delete directories: ${p}`,
                    };
                }
                try {
                    await fs.unlink(absolute);
                } catch (err) {
                    return { ok: false, error: err instanceof Error ? err.message : String(err) };
                }
                return { ok: true, removed: [p], skipped: [] };
            }

            const root = HandlerFile.getWorkspaceRoot();
            const isAbsolutePattern = path.isAbsolute(p.trim());
            const globCwd = isAbsolutePattern ? "/" : root;
            const removed: string[] = [];
            const skipped: FsRemoveSkip[] = [];
            const refusalText = privilegeRefusal().error;

            try {
                for await (const dirent of fs.glob(p, { cwd: globCwd, withFileTypes: true })) {
                    const matchAbs = path.join(dirent.parentPath, dirent.name);
                    // Scratch patterns report absolute paths back; workspace
                    // patterns report relative-to-root, matching what the
                    // model passed in.
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
                        skipped.push({ path: matchRel, reason: refusalText });
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
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }

            removed.sort();
            skipped.sort((a, b) => a.path.localeCompare(b.path));
            return { ok: true, removed, skipped };
        },
    });
}

/**
 * Bundle all filesystem-shaped tools for one agentrun. The writing
 * tools (`file_write`, `file_str_replace`, `file_append`, `fs_remove`)
 * close over `parent.privileged` so the `.md` gate is decided once at
 * registration time and the model's tool calls can't bypass it.
 */
export function buildFsTools(parent: AgentRunRow): ToolSet {
    return {
        file_read: buildFileReadTool(),
        file_write: buildFileWriteTool(parent),
        file_str_replace: buildFileStrReplaceTool(parent),
        file_append: buildFileAppendTool(parent),
        fs_ls: buildLsTool(),
        fs_glob: buildGlobTool(),
        fs_grep: buildGrepTool(),
        fs_remove: buildFsRemoveTool(parent),
    };
}
