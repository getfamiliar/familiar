import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import type { AgentRunRow } from "effective-assistant-shared";
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
 * Resolve a workspace-relative input path to an absolute path,
 * rejecting empty strings, absolute inputs, and any path that escapes
 * the workspace root via `..`. Centralizes the sandbox check so each
 * tool just calls this once and surfaces the error to the model.
 *
 * @throws If `input` is empty, absolute, or escapes the workspace.
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
        throw new Error("path must be relative to the workspace root");
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

/** True if the given path's extension is `.md` (case-insensitive). */
function isMarkdown(p: string): boolean {
    return p.toLowerCase().endsWith(".md");
}

/**
 * Standard refusal returned by writing tools when the agentrun is
 * non-privileged and the target is a markdown file. The text spells
 * out *why* so the model can decide what to do (give up, ask the user,
 * write a non-markdown file instead) instead of looping retries.
 */
function privilegeRefusal(): { readonly ok: false; readonly error: string } {
    return {
        ok: false,
        error:
            "Only privileged agentruns may write to .md files. " +
            "This run is non-privileged. Markdown files (handlers, SOUL.md, " +
            "people/*, etc.) can only be modified by runs descending from " +
            "trusted user input (cli-chat REPL or the operator on Telegram). " +
            "Reads are still allowed.",
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
            "Read a file from the workspace and return its UTF-8 contents. " +
            "Paths are workspace-relative — e.g. `SOUL.md`, `people/anna.md`, " +
            "`data/subscriptions.jsonl`.",
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
            console.error("file_read called with params:", params);
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
            if (isMarkdown(absolute) && !parent.privileged) {
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
            if (isMarkdown(absolute) && !parent.privileged) {
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
 * Refuses `.md` writes for non-privileged runs.
 */
function buildFileAppendTool(parent: AgentRunRow): Tool<FileAppendInput, FileAppendOutput> {
    return tool<FileAppendInput, FileAppendOutput>({
        description:
            "Append content to the end of a file. Creates the file (and any " +
            "missing parent directories) if it does not exist. Useful for " +
            "JSONL tables: each call adds one line. Markdown (.md) appends " +
            "require a privileged run.",
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
                        "Text to append verbatim. Include your own trailing newline " +
                        "for line-oriented files (e.g. JSONL).",
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
            if (isMarkdown(absolute) && !parent.privileged) {
                return privilegeRefusal();
            }
            try {
                await fs.mkdir(path.dirname(absolute), { recursive: true });
                await fs.appendFile(absolute, content, "utf8");
                return { ok: true, bytes: Buffer.byteLength(content, "utf8") };
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
    });
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

/**
 * Bundle all filesystem-shaped tools for one agentrun. The writing
 * tools (`file_write`, `file_str_replace`, `file_append`) close over
 * `parent.privileged` so the `.md` gate is decided once at registration
 * time and the model's tool calls can't bypass it.
 */
export function buildFsTools(parent: AgentRunRow): ToolSet {
    return {
        file_read: buildFileReadTool(),
        file_write: buildFileWriteTool(parent),
        file_str_replace: buildFileStrReplaceTool(parent),
        file_append: buildFileAppendTool(parent),
        ls: buildLsTool(),
        glob: buildGlobTool(),
        grep: buildGrepTool(),
    };
}
