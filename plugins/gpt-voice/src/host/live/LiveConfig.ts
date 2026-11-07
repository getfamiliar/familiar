import { readFileSync } from "node:fs";
import path from "node:path";
import { isSafeIncludePath, parseTemplate, renderTemplate } from "@getfamiliar/shared";
import { parse as parseYaml } from "yaml";

/** Workspace-relative path of the voice model's instructions. */
export const LIVE_CONFIG_FILE = "voice/live.md";

/** Model used when `voice/live.md` names none. */
export const DEFAULT_LIVE_MODEL = "gpt-live-1";

/** Voice used when `voice/live.md` names none. */
export const DEFAULT_LIVE_VOICE = "marin";

/** Splits a markdown file into YAML frontmatter and body. */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Settings of one voice session, read from {@link LIVE_CONFIG_FILE}. */
export interface LiveSettings {
    /** OpenAI Live model id (frontmatter `model`). */
    readonly model: string;
    /** Voice id (frontmatter `voice`). */
    readonly voice: string;
    /** Rendered instructions (the body, with `{file.md}` includes expanded). */
    readonly instructions: string;
    /** Template problems (missing include, bad path), phrased for a log line. */
    readonly warnings: readonly string[];
}

/** Thrown when {@link LIVE_CONFIG_FILE} is missing or malformed. */
export class LiveConfigError extends Error {
    /**
     * @param message What is wrong and how to fix it.
     */
    constructor(message: string) {
        super(message);
        this.name = "LiveConfigError";
    }
}

/**
 * Read the voice model's settings from the workspace. Read on every call,
 * so edits apply to the next call without a restart.
 *
 * The body is a prompt template like `PROMPT.md`: `{SOUL.md}` and other
 * `{path.md}` includes are expanded (workspace-relative, depth-limited);
 * the only placeholder is `{ASSISTANT_NAME}`, any other `{NAME}` stays
 * verbatim.
 *
 * @param workspaceDir Absolute workspace root.
 * @param assistantName Value of `{ASSISTANT_NAME}`.
 * @returns Model, voice and instructions.
 * @throws {LiveConfigError} When the file is missing, its frontmatter is
 *   not a YAML mapping, or `model` / `voice` are not strings.
 */
export function readLiveSettings(workspaceDir: string, assistantName: string): LiveSettings {
    const source = readWorkspaceText(workspaceDir, LIVE_CONFIG_FILE);
    if (source === null) {
        throw new LiveConfigError(
            `workspace/${LIVE_CONFIG_FILE} is missing — restart the daemon to restore the plugin's default, or create it with the instructions for the voice model`,
        );
    }
    const match = FRONTMATTER_PATTERN.exec(source);
    const frontmatter = match === null ? {} : parseFrontmatter(match[1] ?? "");
    const body = match === null ? source : source.slice(match[0].length);
    const parsed = parseTemplate(body, {
        templateName: LIVE_CONFIG_FILE,
        readInclude: (relativePath) => readWorkspaceText(workspaceDir, relativePath),
        templateSources: {},
    });
    const rendered = renderTemplate(parsed, new Map([["ASSISTANT_NAME", assistantName]]));
    const instructions = [rendered.system, rendered.userHead]
        .filter((part) => part !== "")
        .join("\n\n");
    return {
        model: readStringField(frontmatter, "model") ?? DEFAULT_LIVE_MODEL,
        voice: readStringField(frontmatter, "voice") ?? DEFAULT_LIVE_VOICE,
        instructions,
        warnings: parsed.warnings,
    };
}

/**
 * Parse the frontmatter block.
 *
 * @param yaml Text between the `---` fences.
 * @returns The mapping.
 * @throws {LiveConfigError} When it is not a YAML mapping.
 */
function parseFrontmatter(yaml: string): Record<string, unknown> {
    let value: unknown;
    try {
        value = parseYaml(yaml);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new LiveConfigError(
            `workspace/${LIVE_CONFIG_FILE}: invalid frontmatter — ${message}`,
        );
    }
    if (value === null || value === undefined) {
        return {};
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new LiveConfigError(`workspace/${LIVE_CONFIG_FILE}: frontmatter must be a mapping`);
    }
    return value as Record<string, unknown>;
}

/**
 * Read an optional string field of the frontmatter.
 *
 * @param frontmatter Parsed frontmatter.
 * @param key Field name.
 * @returns The trimmed value, or null when absent or empty.
 * @throws {LiveConfigError} When the field is present but not a string.
 */
function readStringField(frontmatter: Record<string, unknown>, key: string): string | null {
    const value = frontmatter[key];
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== "string") {
        throw new LiveConfigError(`workspace/${LIVE_CONFIG_FILE}: "${key}" must be a string`);
    }
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
}

/**
 * Read a workspace file as text.
 *
 * @param workspaceDir Workspace root.
 * @param relativePath Workspace-relative path (checked with `isSafeIncludePath`).
 * @returns The text, or null when the path is unsafe or the file does not exist.
 * @throws {Error} On read errors other than "not found".
 */
function readWorkspaceText(workspaceDir: string, relativePath: string): string | null {
    if (!isSafeIncludePath(relativePath)) {
        return null;
    }
    try {
        return readFileSync(path.join(workspaceDir, relativePath), "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw err;
    }
}
