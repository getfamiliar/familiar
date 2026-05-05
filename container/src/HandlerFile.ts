import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Parsed shape of a handler file's YAML frontmatter.
 *
 * All fields are optional — a handler may omit frontmatter entirely.
 * Frontmatter that *is* present is still type-checked: a `model: 123`
 * is a malformed handler, not an unset one.
 *
 * Fields left undefined by a handler are filled at parse time from the
 * process-wide defaults registered via
 * {@link HandlerFile.setHeaderDefaults}.
 */
export interface HandlerFileHeader {
    /** Provider-specific model id (e.g. `meta-llama/Meta-Llama-3.1-8B-Instruct`). */
    readonly model?: string;
    /** Sampling temperature passed to the model. */
    readonly temperature?: number;
    /** Tool ids the agent is permitted to call during this handler's run. */
    readonly allowedTools?: readonly string[];
    /**
     * Maximum number of tokens the model is allowed to generate in any
     * single step of the tool-loop. Bounds worst-case latency and the
     * size of `result_text` rows when a model goes off the rails into
     * a long monologue (e.g. simulating a transcript). Process-wide
     * default is set by the container entrypoint and should be
     * overridable per handler.
     */
    readonly maxOutputTokens?: number;
    /**
     * When `true`, the agentrun's final `result_text` is also persisted
     * to the `chatmessages` table as an assistant message on the parent
     * event's channel. Useful for chat handlers running on models that
     * stubbornly emit text instead of calling `send_chat` — the agent's
     * natural reply still reaches the user. Default `false`.
     *
     * Note: if the model ALSO calls `send_chat`, both rows are stored
     * and the user sees duplicates. Choose one or the other per handler.
     */
    readonly outputChat?: boolean;
}

/**
 * One parsed handler markdown file.
 *
 * Two ways to construct:
 *
 * - `new HandlerFile(relativePath)` — read and parse any file under
 *   the configured workspace root.
 * - `HandlerFile.load(topic, basename)` — resolve the most-specific
 *   existing handler file for a topic / basename pair (sub-topic
 *   override falls back to parent topic) and parse it.
 *
 * Both paths are synchronous: handler files are small local-disk
 * markdown, so blocking the event loop briefly during construction is
 * preferable to async contagion through every caller.
 *
 * The workspace root and per-field header defaults are process-wide
 * configuration; see {@link HandlerFile.setWorkspaceRoot} and
 * {@link HandlerFile.setHeaderDefaults}.
 */
export class HandlerFile {
    /** Absolute mount path of the workspace. Default `/workspace`. */
    private static workspaceRoot: string = "/workspace";
    /** Defaults applied per-field at parse time when the YAML omits a field. */
    private static headerDefaults: HandlerFileHeader = {};

    /** Workspace-relative path the file was loaded from (e.g. `chat/telegram/index.md`). */
    readonly relativePath: string;
    /** Absolute path on disk: `<workspaceRoot> + relativePath` at construction time. */
    readonly path: string;
    /** Parsed YAML header with static defaults applied per-field. */
    readonly header: HandlerFileHeader;
    /** Markdown body following the frontmatter (or the whole file if no frontmatter). */
    readonly body: string;

    /**
     * Read and parse the file at `<workspaceRoot>/<relativePath>`.
     * Synchronous: blocks while the file is read from disk and the
     * YAML is parsed.
     *
     * @param relativePath Workspace-relative path, with or without a
     *   leading `/`. Used as-is for {@link relativePath}; the absolute
     *   path is resolved against the static workspace root.
     * @throws If the file does not exist, fs read fails, the YAML
     *   frontmatter (if present) is malformed or not a mapping, or any
     *   declared header field has the wrong type.
     */
    constructor(relativePath: string) {
        const normalized = relativePath.replace(/^\/+/, "");
        const absolute = path.join(HandlerFile.workspaceRoot, normalized);
        const source = readFileSync(absolute, "utf8");
        const { header: declared, body } = parseHandler(absolute, source);

        this.relativePath = normalized;
        this.path = absolute;
        this.header = mergeDefaults(declared, HandlerFile.headerDefaults);
        this.body = body;
    }

    /**
     * Resolve a handler file for the given topic + basename and
     * construct it. Resolution rules — for topic `chat:telegram` and
     * basename `analyze`:
     *
     *   1. `<workspaceRoot>/chat/telegram/analyze.md` (sub-topic override)
     *   2. `<workspaceRoot>/chat/analyze.md` (parent topic fallback)
     *
     * Topics without a sub-topic resolve to a single candidate.
     *
     * @throws If neither candidate path exists, or if the resolved
     *   file fails the same parsing checks as the public constructor.
     */
    static load(topic: string, basename: string): HandlerFile {
        const candidates = resolveCandidates(topic, basename);
        for (const candidate of candidates) {
            const absolute = path.join(HandlerFile.workspaceRoot, candidate);
            if (existsSync(absolute)) {
                return new HandlerFile(candidate);
            }
        }
        throw new Error(
            `Handler not found for topic="${topic}" basename="${basename}". Tried: ${candidates.join(", ")}`,
        );
    }

    /**
     * Override the absolute workspace mount path. Process-wide; the
     * change is visible to every subsequent {@link HandlerFile}
     * construction. Tests should call this in their setup; production
     * code keeps the default `/workspace`.
     */
    static setWorkspaceRoot(absoluteDir: string): void {
        HandlerFile.workspaceRoot = absoluteDir;
    }

    /**
     * Read the currently configured workspace root. Other workspace-
     * aware modules (e.g. `buildSystemPrompt` reading `SOUL.md` /
     * `CONTEXT.md`) use this so the workspace location has a single
     * source of truth.
     */
    static getWorkspaceRoot(): string {
        return HandlerFile.workspaceRoot;
    }

    /**
     * Set defaults applied per-field at parse time when the YAML
     * header omits a field. Process-wide; the change is visible to
     * every subsequent {@link HandlerFile} construction. Pass `{}` to
     * clear.
     */
    static setHeaderDefaults(defaults: HandlerFileHeader): void {
        HandlerFile.headerDefaults = defaults;
    }
}

/**
 * Build the ordered list of candidate workspace-relative paths for a
 * topic / basename pair, most-specific first.
 */
function resolveCandidates(topic: string, basename: string): readonly string[] {
    const colonIndex = topic.indexOf(":");
    if (colonIndex < 0) {
        return [path.join(topic, `${basename}.md`)];
    }
    const parent = topic.slice(0, colonIndex);
    const sub = topic.slice(colonIndex + 1);
    return [path.join(parent, sub, `${basename}.md`), path.join(parent, `${basename}.md`)];
}

/**
 * Split a handler file into YAML frontmatter (optional) and markdown
 * body, validating the header into a {@link HandlerFileHeader}. The
 * returned header reflects only what the YAML declared; defaults are
 * applied by the caller.
 *
 * @throws If the YAML block is present but malformed, or any declared
 *   field has the wrong type.
 */
function parseHandler(
    filePath: string,
    source: string,
): { header: HandlerFileHeader; body: string } {
    const trimmed = source.trim();
    const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n?([\s\S]*)$/);
    if (!match) {
        return { header: {}, body: trimmed };
    }

    let parsed: unknown;
    try {
        parsed = parseYaml(match[1]);
    } catch (err) {
        throw new Error(
            `${filePath}: failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    const body = (match[2] ?? "").trim();

    if (parsed === null || parsed === undefined) {
        return { header: {}, body };
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${filePath}: YAML frontmatter must be a mapping`);
    }

    const raw = parsed as Record<string, unknown>;
    const header: HandlerFileHeader = {
        model: optionalString(filePath, raw, "model"),
        temperature: optionalNumber(filePath, raw, "temperature"),
        allowedTools: optionalStringArray(filePath, raw, "allowedTools"),
        maxOutputTokens: optionalPositiveInteger(filePath, raw, "maxOutputTokens"),
        outputChat: optionalBoolean(filePath, raw, "outputChat"),
    };

    return { header, body };
}

/**
 * Merge a declared header with process-wide defaults. A declared
 * `undefined` (field not present in YAML) falls through to the
 * default; a declared value always wins.
 */
function mergeDefaults(
    declared: HandlerFileHeader,
    defaults: HandlerFileHeader,
): HandlerFileHeader {
    return {
        model: declared.model ?? defaults.model,
        temperature: declared.temperature ?? defaults.temperature,
        allowedTools: declared.allowedTools ?? defaults.allowedTools,
        maxOutputTokens: declared.maxOutputTokens ?? defaults.maxOutputTokens,
        outputChat: declared.outputChat ?? defaults.outputChat,
    };
}

function optionalString(
    filePath: string,
    raw: Record<string, unknown>,
    field: string,
): string | undefined {
    if (!(field in raw) || raw[field] === undefined) {
        return undefined;
    }
    const value = raw[field];
    if (typeof value !== "string") {
        throw new Error(`${filePath}: header field "${field}" must be a string`);
    }
    return value;
}

function optionalNumber(
    filePath: string,
    raw: Record<string, unknown>,
    field: string,
): number | undefined {
    if (!(field in raw) || raw[field] === undefined) {
        return undefined;
    }
    const value = raw[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${filePath}: header field "${field}" must be a finite number`);
    }
    return value;
}

function optionalBoolean(
    filePath: string,
    raw: Record<string, unknown>,
    field: string,
): boolean | undefined {
    if (!(field in raw) || raw[field] === undefined) {
        return undefined;
    }
    const value = raw[field];
    if (typeof value !== "boolean") {
        throw new Error(`${filePath}: header field "${field}" must be a boolean`);
    }
    return value;
}

function optionalPositiveInteger(
    filePath: string,
    raw: Record<string, unknown>,
    field: string,
): number | undefined {
    if (!(field in raw) || raw[field] === undefined) {
        return undefined;
    }
    const value = raw[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new Error(`${filePath}: header field "${field}" must be a positive integer`);
    }
    return value;
}

function optionalStringArray(
    filePath: string,
    raw: Record<string, unknown>,
    field: string,
): readonly string[] | undefined {
    if (!(field in raw) || raw[field] === undefined) {
        return undefined;
    }
    const value = raw[field];
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        throw new Error(`${filePath}: header field "${field}" must be an array of strings`);
    }
    return value as string[];
}
