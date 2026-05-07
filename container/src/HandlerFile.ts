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
    /**
     * Tool-filter expression. Controls which MCP tools are exposed to
     * this handler's agent loop. See `tools/ToolFilter.ts` for the full
     * grammar (groups, paths with `*` globs, `&&` / `||` / `!`). When
     * omitted, **no MCP tools** are exposed — system tools (`send_chat`,
     * `queue_run`, filesystem) are always present regardless.
     *
     * The built-in group `all` is the escape hatch for handlers that
     * genuinely want every declared MCP's tools (`tools: all`).
     */
    readonly tools?: string;
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
     * Controls how this file combines with its inheritance chain during
     * {@link HandlerFile.load}. Topics can nest arbitrarily deep
     * (`chat:telegram:group:reaction`); each `:`-segment maps to a
     * folder, and every existing file in the chain layers into the
     * merge by default.
     *
     * - `merge` (default) — every ancestor file in the chain is loaded
     *   and folded root-first; deeper files override declared header
     *   fields and append their body. Missing intermediate levels are
     *   skipped silently.
     * - `replace` — declared on any file in the chain, this cuts off
     *   the merge above that file: it becomes the new root, and every
     *   higher-level ancestor is ignored. Useful for sub-topics that
     *   want to fully override more general guidance.
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
     * Workspace-relative paths of every ancestor file that contributed
     * to this {@link HandlerFile}'s merged body and header, ordered
     * nearest-ancestor first. Empty when no merge happened (only the
     * leaf file existed, or the leaf opted out via `mergeMode: replace`).
     *
     * For topic `chat:telegram:group` with handler `index`, if all four
     * candidate files exist with no `replace`, this is
     * `["chat/telegram/index.md", "chat/index.md"]` and `relativePath`
     * is the leaf `chat/telegram/group/index.md`. Reading the array
     * directly yields the inheritance chain in human-readable order.
     */
    readonly inheritsFrom: readonly string[];

    private constructor(
        relativePath: string,
        absolutePath: string,
        header: HandlerFileHeader,
        body: string,
        inheritsFrom: readonly string[] = [],
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
     * construct it. Resolution rules — for topic `chat:telegram:group`
     * and basename `index`:
     *
     *   1. `<workspaceRoot>/chat/telegram/group/index.md` (deepest)
     *   2. `<workspaceRoot>/chat/telegram/index.md`
     *   3. `<workspaceRoot>/chat/index.md` (root fallback)
     *
     * The deepest existing file is the **leaf** (its path becomes
     * {@link relativePath}). Every ancestor that exists on disk layers
     * into the merge — declared header fields override (leaf wins),
     * bodies concatenate root-first with blank lines between. Missing
     * intermediate levels are simply skipped.
     *
     * `mergeMode: "replace"` declared on any file in the chain cuts
     * off everything above it: that file becomes the new root of the
     * merge. The cutoff is found by walking deepest-first; the first
     * `replace` encountered terminates the upward walk.
     *
     * @throws If no candidate file exists on disk, or if any resolved
     *   file fails the same parsing checks as {@link read}.
     */
    static load(topic: string, basename: string): HandlerFile {
        // Deepest path first, root last.
        const candidatesDeepestFirst = resolveCandidates(topic, basename);

        // Parse every candidate that exists on disk, preserving the
        // deepest-first order so we can apply the `replace` cutoff
        // before reversing for the merge fold.
        const existingDeepestFirst: { rel: string; abs: string; declared: DeclaredFile }[] = [];
        for (const rel of candidatesDeepestFirst) {
            const abs = path.join(HandlerFile.workspaceRoot, rel);
            if (existsSync(abs)) {
                existingDeepestFirst.push({ rel, abs, declared: parseFile(abs) });
            }
        }

        if (existingDeepestFirst.length === 0) {
            throw new Error(
                `Handler not found for topic="${topic}" basename="${basename}". Tried: ${candidatesDeepestFirst.join(", ")}`,
            );
        }

        // Apply `mergeMode: replace`: walking deepest-first, the first
        // file that declares `replace` is the new root — it stays in
        // the chain, everything above it is dropped. (`replace` on the
        // leaf alone means "use only the leaf".)
        const replaceAt = existingDeepestFirst.findIndex(
            (entry) => entry.declared.header.mergeMode === "replace",
        );
        const chainDeepestFirst =
            replaceAt >= 0 ? existingDeepestFirst.slice(0, replaceAt + 1) : existingDeepestFirst;

        // Fold root-first so each subsequent (deeper) file overrides
        // declared fields and appends body. The leaf is the deepest
        // entry (chainDeepestFirst[0]); ancestors are everything else.
        const chainRootFirst = [...chainDeepestFirst].reverse();
        let mergedHeader: HandlerFileHeader = {};
        let mergedBody = "";
        for (const entry of chainRootFirst) {
            mergedHeader = mergeDeclared(mergedHeader, entry.declared.header);
            mergedBody = concatBodies(mergedBody, entry.declared.body);
        }

        const leaf = chainDeepestFirst[0];
        const ancestorsNearestFirst = chainDeepestFirst.slice(1).map((entry) => entry.rel);

        return new HandlerFile(
            leaf.rel,
            leaf.abs,
            mergeDefaults(mergedHeader, HandlerFile.headerDefaults),
            mergedBody,
            ancestorsNearestFirst,
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
 * topic / basename pair, deepest first. Each `:`-separated segment of
 * the topic becomes a folder level; the basename gains a `.md` suffix.
 *
 * For topic `chat:telegram:group` and basename `index`:
 *
 *   1. `chat/telegram/group/index.md`  ← deepest (leaf candidate)
 *   2. `chat/telegram/index.md`
 *   3. `chat/index.md`                  ← root
 *
 * The caller treats this as a "from leaf walking up to root" sequence;
 * intermediate levels that don't exist on disk are simply skipped.
 */
function resolveCandidates(topic: string, basename: string): readonly string[] {
    const segments = topic.split(":");
    const candidates: string[] = [];
    for (let depth = segments.length; depth >= 1; depth--) {
        candidates.push(path.join(...segments.slice(0, depth), `${basename}.md`));
    }
    return candidates;
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
        tools: child.tools ?? parent.tools,
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
        tools: optionalString(filePath, raw, "tools"),
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
        tools: declared.tools ?? defaults.tools,
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
