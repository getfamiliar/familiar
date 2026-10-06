import { CACHE_MARKER_PLACEHOLDER } from "@getfamiliar/shared";

/**
 * Matches one template token: `{NAME}` (upper-case placeholder) or
 * `{path.md}` (workspace include). Anything else in braces — JSON
 * examples, `{lowercase}` prose — is left untouched.
 */
const TOKEN_PATTERN = /\{([A-Z][A-Z0-9_]*|[\w./-]+\.md)\}/g;

/**
 * Maximum nesting of template sources (includes and template-valued
 * placeholders like `HANDLER_CONTENT`) below the top-level template.
 */
export const MAX_TEMPLATE_DEPTH = 3;

/** One node of a parsed template. */
export type TemplateNode =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "placeholder"; readonly name: string }
    | {
          readonly type: "include";
          readonly path: string;
          readonly children: readonly TemplateNode[];
      }
    | {
          readonly type: "source";
          readonly name: string;
          readonly children: readonly TemplateNode[];
      };

/** A placeholder reference found while parsing, with its position relative to the marker. */
export interface PlaceholderUse {
    readonly name: string;
    /** `true` when the reference ends up in the system prompt (before `{CACHE_MARKER}`). */
    readonly isBeforeMarker: boolean;
}

/** Result of {@link parseTemplate}. */
export interface ParsedTemplate {
    /** Nodes rendered into the system prompt. */
    readonly systemNodes: readonly TemplateNode[];
    /** Nodes rendered into the head of the current user message. */
    readonly userHeadNodes: readonly TemplateNode[];
    /** Every placeholder reference, in template order (duplicates kept). */
    readonly uses: readonly PlaceholderUse[];
    /** Workspace files pulled in via `{path.md}`, in template order. */
    readonly includes: readonly string[];
    /** Problems found while parsing, phrased for a log line. */
    readonly warnings: readonly string[];
}

/** Inputs to {@link parseTemplate}. */
export interface ParseTemplateOptions {
    /** Human-readable name of the template, used in warnings (e.g. `PROMPT.md`). */
    readonly templateName: string;
    /**
     * Read a workspace-relative include. Returns the (already truncated)
     * text, or `null` when the file does not exist.
     */
    readonly readInclude: (relativePath: string) => string | null;
    /**
     * Placeholders whose value is itself template text (workspace
     * markdown, e.g. `HANDLER_CONTENT`). They are expanded like includes
     * but not redacted.
     */
    readonly templateSources: Readonly<Record<string, string>>;
}

/** Rendered output of {@link renderTemplate}. */
export interface RenderedTemplate {
    readonly system: string;
    readonly userHead: string;
}

/**
 * Parse a prompt template into nodes, expanding workspace includes and
 * template-valued placeholders recursively.
 *
 * Only workspace markdown is template: the top-level template, files it
 * includes, and {@link ParseTemplateOptions.templateSources}. Values
 * produced by code or plugins are inserted later by
 * {@link renderTemplate} and never scanned for tokens, so text from an
 * event (a mail containing `{SOUL.md}`) cannot pull files into the
 * prompt.
 *
 * The first `{CACHE_MARKER}` in the top-level template splits system
 * prompt from user-message head. A marker anywhere else (an include, the
 * handler body, a second one) is dropped with a warning.
 *
 * Problems never throw: an invalid include path, a missing include, a
 * cycle or excessive nesting leave a warning and keep the token
 * verbatim (or empty, for a missing file) so the run still proceeds.
 *
 * @param source The top-level template text.
 * @param options Include reader, template sources and naming.
 * @returns The parsed template.
 */
export function parseTemplate(source: string, options: ParseTemplateOptions): ParsedTemplate {
    const state: ParseState = {
        options,
        uses: [],
        includes: [],
        warnings: [],
        isMarkerSeen: false,
        systemNodes: [],
        userHeadNodes: [],
    };
    parseInto(source, 0, [options.templateName], state, true);
    return {
        systemNodes: state.systemNodes,
        userHeadNodes: state.userHeadNodes,
        uses: state.uses,
        includes: state.includes,
        warnings: state.warnings,
    };
}

/**
 * Render a parsed template with resolved placeholder values. A
 * placeholder without a value stays as its literal `{NAME}` token.
 *
 * @param parsed The parsed template.
 * @param values Resolved value per placeholder name.
 * @param shouldRedactIncludes When `true`, each `{path.md}` include is
 *   rendered as `<content of file path>` instead of its body — used for
 *   the audit-log copy under `core.logSystemPrompt: non-static`.
 * @returns System prompt and user-message head, each trimmed.
 */
export function renderTemplate(
    parsed: ParsedTemplate,
    values: ReadonlyMap<string, string>,
    shouldRedactIncludes = false,
): RenderedTemplate {
    return {
        system: renderNodes(parsed.systemNodes, values, shouldRedactIncludes).trim(),
        userHead: renderNodes(parsed.userHeadNodes, values, shouldRedactIncludes).trim(),
    };
}

/** Mutable state threaded through the recursive parse. */
interface ParseState {
    readonly options: ParseTemplateOptions;
    readonly uses: PlaceholderUse[];
    readonly includes: string[];
    readonly warnings: string[];
    isMarkerSeen: boolean;
    readonly systemNodes: TemplateNode[];
    readonly userHeadNodes: TemplateNode[];
}

/**
 * Parse `source` and append its nodes to the active top-level list (or
 * to `into`, for nested sources).
 *
 * @param source Text to parse.
 * @param depth Nesting depth; 0 is the top-level template.
 * @param chain Names of the sources currently being expanded, for cycle
 *   detection and warning context.
 * @param state Shared parse state.
 * @param isTopLevel Whether nodes go to the top-level lists (`true`) or
 *   are returned for a nested node.
 * @returns The nodes parsed from a nested source (empty at top level).
 */
function parseInto(
    source: string,
    depth: number,
    chain: readonly string[],
    state: ParseState,
    isTopLevel: boolean,
): TemplateNode[] {
    const nested: TemplateNode[] = [];
    const push = (node: TemplateNode): void => {
        if (!isTopLevel) {
            nested.push(node);
            return;
        }
        (state.isMarkerSeen ? state.userHeadNodes : state.systemNodes).push(node);
    };
    const where = chain[chain.length - 1];

    let cursor = 0;
    for (const match of source.matchAll(TOKEN_PATTERN)) {
        const index = match.index ?? 0;
        if (index > cursor) {
            push({ type: "text", text: source.slice(cursor, index) });
        }
        cursor = index + match[0].length;
        const token = match[1] ?? "";

        if (token === CACHE_MARKER_PLACEHOLDER) {
            if (depth === 0 && !state.isMarkerSeen) {
                state.isMarkerSeen = true;
                continue;
            }
            state.warnings.push(
                depth === 0
                    ? `${where}: second {${CACHE_MARKER_PLACEHOLDER}} ignored — only the first one splits the prompt`
                    : `${where}: {${CACHE_MARKER_PLACEHOLDER}} ignored — it only works in the top-level template`,
            );
            continue;
        }

        if (token.endsWith(".md")) {
            push(parseInclude(token, match[0], depth, chain, state));
            continue;
        }

        const templateSource = state.options.templateSources[token];
        if (templateSource !== undefined) {
            if (depth >= MAX_TEMPLATE_DEPTH || chain.includes(`{${token}}`)) {
                state.warnings.push(
                    `${where}: {${token}} not expanded — nested too deep or recursive (${chain.join(" → ")})`,
                );
                push({ type: "text", text: match[0] });
                continue;
            }
            const children = parseInto(
                templateSource,
                depth + 1,
                [...chain, `{${token}}`],
                state,
                false,
            );
            push({ type: "source", name: token, children });
            continue;
        }

        state.uses.push({ name: token, isBeforeMarker: !state.isMarkerSeen });
        push({ type: "placeholder", name: token });
    }
    if (cursor < source.length) {
        push({ type: "text", text: source.slice(cursor) });
    }
    return nested;
}

/**
 * Build the node for one `{path.md}` token, reading and recursively
 * parsing the file.
 */
function parseInclude(
    includePath: string,
    literal: string,
    depth: number,
    chain: readonly string[],
    state: ParseState,
): TemplateNode {
    const where = chain[chain.length - 1];
    if (!isSafeIncludePath(includePath)) {
        state.warnings.push(
            `${where}: include {${includePath}} rejected — use a workspace-relative path without ".."`,
        );
        return { type: "text", text: literal };
    }
    if (depth >= MAX_TEMPLATE_DEPTH || chain.includes(includePath)) {
        state.warnings.push(
            `${where}: include {${includePath}} not expanded — nested too deep or recursive (${[...chain, includePath].join(" → ")})`,
        );
        return { type: "text", text: literal };
    }
    const body = state.options.readInclude(includePath);
    if (body === null) {
        state.warnings.push(`${where}: include {${includePath}} not found in the workspace`);
        return { type: "include", path: includePath, children: [] };
    }
    state.includes.push(includePath);
    const children = parseInto(body, depth + 1, [...chain, includePath], state, false);
    return { type: "include", path: includePath, children };
}

/**
 * Whether an include path stays inside the workspace: relative, no
 * `..` segment, no empty segment.
 *
 * @param includePath The path inside the braces.
 * @returns `true` when the path is acceptable.
 */
export function isSafeIncludePath(includePath: string): boolean {
    if (includePath.startsWith("/")) {
        return false;
    }
    return includePath.split("/").every((segment) => segment !== ".." && segment.length > 0);
}

/** Concatenate the rendered text of `nodes`. */
function renderNodes(
    nodes: readonly TemplateNode[],
    values: ReadonlyMap<string, string>,
    shouldRedactIncludes: boolean,
): string {
    let out = "";
    for (const node of nodes) {
        switch (node.type) {
            case "text":
                out += node.text;
                break;
            case "placeholder":
                out += values.get(node.name) ?? `{${node.name}}`;
                break;
            case "include":
                out += shouldRedactIncludes
                    ? `<content of file ${node.path}>`
                    : renderNodes(node.children, values, shouldRedactIncludes);
                break;
            case "source":
                out += renderNodes(node.children, values, shouldRedactIncludes);
                break;
        }
    }
    return out;
}
