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
 * Fields left undefined by a handler are filled at finalize time from
 * the process-wide defaults registered via
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
    /**
     * Controls how a sub-topic handler combines with its parent-topic
     * fallback during {@link HandlerFile.load}. Only meaningful on the
     * sub-topic file (e.g. `chat/telegram/analyze.md`).
     *
     * - `merge` (default) — the parent file is loaded first; this
     *   file's declared header fields override the parent's, and this
     *   file's body is appended after the parent's with a blank line
     *   between.
     * - `replace` — the parent file is ignored; behaves like the
     *   parent doesn't exist.
     */
    readonly mergeMode?: "merge" | "replace";
}

/** Pair returned by the parser before defaults are applied. */
interface DeclaredFile {
    readonly header: HandlerFileHeader;
    readonly body: string;
}

/**
 * One parsed handler markdown file.
 *
 * Two ways to construct:
 *
 * - {@link HandlerFile.read} — read and parse one specific file under
 *   the configured workspace root, no merge semantics.
 * - {@link HandlerFile.load} — resolve a topic / basename pair to the
 *   most-specific existing handler file, possibly layering it on top
 *   of a parent-topic file (see {@link HandlerFileHeader.mergeMode}).
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
    /** Defaults applied per-field at finalize time when the YAML omits a field. */
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
     * If this file's body and header are the result of a sub-topic
     * merge ({@link HandlerFileHeader.mergeMode} = `merge`), the
     * workspace-relative path of the parent-topic file that was
     * layered in. `undefined` when no merge happened.
     */
    readonly inheritsFrom?: string;

    private constructor(
        relativePath: string,
        absolutePath: string,
        header: HandlerFileHeader,
        body: string,
        inheritsFrom?: string,
    ) {
        this.relativePath = relativePath;
        this.path = absolutePath;
        this.header = header;
        this.body = body;
        this.inheritsFrom = inheritsFrom;
    }

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
    static read(relativePath: string): HandlerFile {
        const normalized = relativePath.replace(/^\/+/, "");
        const absolute = path.join(HandlerFile.workspaceRoot, normalized);
        const declared = parseFile(absolute);
        return new HandlerFile(
            normalized,
            absolute,
            mergeDefaults(declared.header, HandlerFile.headerDefaults),
            declared.body,
        );
    }

    /**
     * Resolve a handler file for the given topic + basename and
     * construct it. Resolution rules — for topic `chat:telegram` and
     * basename `analyze`:
     *
     *   1. `<workspaceRoot>/chat/telegram/analyze.md` (sub-topic, "child")
     *   2. `<workspaceRoot>/chat/analyze.md` (parent topic fallback)
     *
     * If both exist, the child's `mergeMode` controls the outcome:
     * `merge` (default) layers the child onto the parent — declared
     * header fields override, bodies concatenate with `parent` first
     * and a blank line between. `replace` ignores the parent. If only
     * one of the two exists, that file is used as-is. Topics without a
     * sub-topic resolve to a single candidate; `mergeMode` is moot.
     *
     * @throws If neither candidate exists, or if a resolved file fails
     *   the same parsing checks as {@link read}.
     */
    static load(topic: string, basename: string): HandlerFile {
        const candidates = resolveCandidates(topic, basename);
        const [childRel, parentRel] = candidates;
        const childAbs = path.join(HandlerFile.workspaceRoot, childRel);
        const parentAbs =
            parentRel !== undefined ? path.join(HandlerFile.workspaceRoot, parentRel) : null;

        const childExists = existsSync(childAbs);
        const parentExists = parentAbs !== null && existsSync(parentAbs);

        if (!childExists && !parentExists) {
            throw new Error(
                `Handler not found for topic="${topic}" basename="${basename}". Tried: ${candidates.join(", ")}`,
            );
        }

        if (!childExists) {
            // Only parent exists.
            const declared = parseFile(parentAbs as string);
            return new HandlerFile(
                parentRel as string,
                parentAbs as string,
                mergeDefaults(declared.header, HandlerFile.headerDefaults),
                declared.body,
            );
        }

        const child = parseFile(childAbs);

        if (!parentExists || child.header.mergeMode === "replace") {
            return new HandlerFile(
                childRel,
                childAbs,
                mergeDefaults(child.header, HandlerFile.headerDefaults),
                child.body,
            );
        }

        // Both exist and child opts in (or doesn't opt out) of merge.
        const parent = parseFile(parentAbs as string);
        const mergedDeclared = mergeDeclared(parent.header, child.header);
        const mergedBody = concatBodies(parent.body, child.body);
        return new HandlerFile(
            childRel,
            childAbs,
            mergeDefaults(mergedDeclared, HandlerFile.headerDefaults),
            mergedBody,
            parentRel as string,
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
     * Set defaults applied per-field at finalize time when the YAML
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
 * Read and parse a handler file at the given absolute path. Returns
 * the *declared* header (only fields actually present in YAML) plus
 * the body. Process-wide defaults are applied later, after any merge.
 *
 * @throws If the file is missing, the YAML is malformed, or any
 *   declared field has the wrong type.
 */
function parseFile(absolute: string): DeclaredFile {
    const source = readFileSync(absolute, "utf8");
    return parseHandler(absolute, source);
}

/**
 * Merge a child's declared header onto a parent's declared header.
 * Each child field overrides the parent's iff the child declared it
 * (i.e. non-undefined). This is the same `??` shape used by
 * {@link mergeDefaults}, but operates on declared (pre-defaults)
 * headers so a child silently omitting `model` doesn't clobber a
 * parent's *declaration*.
 */
function mergeDeclared(parent: HandlerFileHeader, child: HandlerFileHeader): HandlerFileHeader {
    return {
        model: child.model ?? parent.model,
        temperature: child.temperature ?? parent.temperature,
        allowedTools: child.allowedTools ?? parent.allowedTools,
        maxOutputTokens: child.maxOutputTokens ?? parent.maxOutputTokens,
        outputChat: child.outputChat ?? parent.outputChat,
        mergeMode: child.mergeMode ?? parent.mergeMode,
    };
}

/**
 * Concatenate parent and child bodies with a blank line between.
 * Either side being empty short-circuits to the other so the result
 * doesn't lead with whitespace.
 */
function concatBodies(parentBody: string, childBody: string): string {
    if (parentBody.length === 0) {
        return childBody;
    }
    if (childBody.length === 0) {
        return parentBody;
    }
    return `${parentBody}\n\n${childBody}`;
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
function parseHandler(filePath: string, source: string): DeclaredFile {
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
        mergeMode: optionalEnum(filePath, raw, "mergeMode", ["merge", "replace"]),
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
        mergeMode: declared.mergeMode ?? defaults.mergeMode,
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

function optionalEnum<T extends string>(
    filePath: string,
    raw: Record<string, unknown>,
    field: string,
    allowed: readonly T[],
): T | undefined {
    if (!(field in raw) || raw[field] === undefined) {
        return undefined;
    }
    const value = raw[field];
    if (typeof value !== "string" || !allowed.includes(value as T)) {
        throw new Error(
            `${filePath}: header field "${field}" must be one of ${allowed.map((v) => `"${v}"`).join(", ")}`,
        );
    }
    return value as T;
}
