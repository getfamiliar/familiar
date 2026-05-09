import { ALL_GROUP_NAME, IDENT_PATTERN, NONE_GROUP_NAME } from "effective-assistant-shared";

/**
 * Per-handler tool-filter DSL: parser, AST, and evaluator.
 *
 * Expression grammar (recursive descent):
 *
 *     expr        := plusMinus
 *     plusMinus   := and (('+' | '-') and)*
 *     and         := atom ('&' atom)*
 *     atom        := bareword | '(' expr ')'
 *
 *     bareword    := [a-zA-Z0-9_*]+
 *
 * Operators:
 *
 * - `a + b` — both `a` and `b` together (set union).
 * - `a - b` — `a` without the tools in `b` (set difference).
 * - `a & b` — tools in `a` and `b` both (set intersection).
 *
 * Precedence: `&` binds tighter than `+`/`-`. `+` and `-` share one
 * level and are parsed left-associatively (`a + b - c` is `(a + b)
 * - c`). Whitespace is insignificant. Parens override.
 *
 * **Names use underscores only — never hyphens.** Tool keys are
 * sanitized to underscores by `McpClientPool` before the DSL ever
 * sees them (any `-` in an MCP tool's original name is folded to
 * `_`). MCP ids in `mcp.yml` are constrained to alnum-only by the
 * loader so each id is itself a valid group name. Toolgroup file
 * stems must match the same alnum-only shape. `-` inside an
 * expression is therefore unconditionally the difference operator.
 *
 * **One atom shape for both groups and tool patterns.** A bareword
 * is classified at evaluation time by regex:
 *
 * - matches `^[a-z][a-z0-9]*$` (lowercase alnum, leading letter,
 *   no `_`, no `*`) → **group** lookup (throws on missing).
 * - anything else → **tool pattern** matched against the pool's
 *   namespaced keys with `*` as a glob wildcard.
 *
 * Tool keys always have the form `${id}_${name}` and contain at
 * least one underscore. That makes the split structurally
 * unambiguous: an alnum-only lowercase bareword can never match a
 * tool key, so it must be a group reference.
 *
 * Built-in groups handled by the evaluator before any user
 * lookup:
 *
 * - `all`    — every key in the available pool (system ∪ MCP).
 * - `system` — only system-tool keys, supplied via `builtins`.
 * - `mcp`    — only MCP-tool keys, supplied via `builtins`.
 * - `none`   — empty set. Lets a child handler override its
 *   parent's `tools:` to nothing under the replace-merge rule.
 * - `<mcp-id>` — for every entry declared in `mcp.yml`, the id is
 *   exposed as a same-named group resolving to that MCP's tool
 *   keys. Supplied via `builtins` by the caller. Reserved names
 *   (`all`, `system`, `mcp`, `none`) are rejected by the
 *   `mcp.yml` linter so they can never collide here.
 */

export {
    ALL_GROUP_NAME,
    IDENT_PATTERN,
    MCP_GROUP_NAME,
    NONE_GROUP_NAME,
    RESERVED_GROUP_NAMES,
    SYSTEM_GROUP_NAME,
} from "effective-assistant-shared";

/** Pattern any single bareword (group or tool) must match. */
const BAREWORD_PATTERN = /^[a-zA-Z0-9_*]+$/;

/** Tool-pattern entry: glob string matched against namespaced pool keys. */
export interface ToolEntry {
    readonly kind: "tool";
    readonly pattern: string;
}

/** Group reference by name (must match {@link IDENT_PATTERN}). */
export interface GroupEntry {
    readonly kind: "group";
    readonly name: string;
}

/** One entry in a group file (post-parse). Used by {@link ToolGroupLoader}. */
export type GroupLineEntry = ToolEntry | GroupEntry;

/** A `GroupDef` is the ordered list of entries declared in a group's `.txt` file. */
export type GroupDef = readonly GroupLineEntry[];

/**
 * Lazy lookup for user-defined groups. Returns the group's parsed
 * entries, or `undefined` if no `<name>.txt` file exists. Throws
 * (with file + line number) if the file exists but is malformed.
 *
 * The evaluator never calls the lookup for a reserved built-in
 * (`all` / `system` / `mcp` / `none`); those are resolved
 * internally so a malformed file in the workspace can't poison
 * built-in resolution.
 */
export type GroupLookup = (name: string) => GroupDef | undefined;

/** AST node returned by {@link parseExpression} and consumed by {@link evaluate}. */
export type FilterAst =
    | { readonly type: "plus"; readonly left: FilterAst; readonly right: FilterAst }
    | { readonly type: "minus"; readonly left: FilterAst; readonly right: FilterAst }
    | { readonly type: "and"; readonly left: FilterAst; readonly right: FilterAst }
    | (GroupEntry & { readonly type: "group" })
    | (ToolEntry & { readonly type: "tool" });

/**
 * Parse a `tools:` expression string into an AST. Throws with a
 * positional message on syntax errors. The caller hands the AST to
 * {@link evaluate} per agentrun.
 */
export function parseExpression(src: string): FilterAst {
    const tokens = tokenize(src);
    const parser = new Parser(tokens, src);
    const ast = parser.parseExpr();
    parser.expectEnd();
    return ast;
}

/**
 * Parse a single line from a group `.txt` file into a {@link GroupLineEntry}.
 * Handles trimming, comments, and blank lines: returns `null` for those.
 * Throws on malformed lines.
 */
export function parseGroupLine(line: string): GroupLineEntry | null {
    const stripped = stripComment(line).trim();
    if (stripped.length === 0) {
        return null;
    }
    if (!BAREWORD_PATTERN.test(stripped)) {
        throw new Error(
            `expected a group name or tool pattern matching ${BAREWORD_PATTERN}, got ${JSON.stringify(stripped)}`,
        );
    }
    return classifyBareword(stripped);
}

/**
 * Evaluate a parsed expression against a snapshot of available tool
 * keys plus a lazy group lookup. Returns the filtered set.
 *
 * @param ast Parsed expression tree from {@link parseExpression}.
 * @param available Every tool key the agentrun currently exposes —
 *   system tools plus namespaced MCP-tool keys, unioned.
 * @param lookup Lazy lookup for user-defined groups under
 *   `workspace/toolgroups/`. Only invoked for non-reserved names.
 * @param builtins Per-call values for the named built-in groups
 *   `system` and `mcp`, plus one entry per declared MCP id (so
 *   `tools: fetch` resolves to every `fetch_*` key without a user
 *   group file). `all` and `none` are computed from `available`
 *   directly and don't need entries here. Pass an empty map (or
 *   omit) when the caller doesn't carry that distinction
 *   (e.g. unit tests that don't exercise `system` / `mcp`).
 * @throws On unknown groups, cycles in the group chain, or a
 *   malformed group file reached by the lookup.
 */
export function evaluate(
    ast: FilterAst,
    available: ReadonlySet<string>,
    lookup: GroupLookup,
    builtins: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): Set<string> {
    return evalNode(ast, available, lookup, builtins, new Set());
}

/**
 * Decide whether a bareword refers to a group (lowercase ident, no
 * underscore) or a tool pattern. Used by both the expression parser
 * and the group-line parser so the rule is identical everywhere.
 */
function classifyBareword(token: string): GroupLineEntry {
    if (IDENT_PATTERN.test(token)) {
        return { kind: "group", name: token };
    }
    return { kind: "tool", pattern: token };
}

/**
 * Lightweight tokenizer. Returns a flat array — the parser consumes
 * positionally. Throws on unexpected characters.
 */
type Token =
    | { kind: "lparen"; pos: number }
    | { kind: "rparen"; pos: number }
    | { kind: "and"; pos: number }
    | { kind: "plus"; pos: number }
    | { kind: "minus"; pos: number }
    | { kind: "bareword"; value: string; pos: number }
    | { kind: "end"; pos: number };

function tokenize(src: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") {
            i++;
            continue;
        }
        if (c === "(") {
            tokens.push({ kind: "lparen", pos: i });
            i++;
            continue;
        }
        if (c === ")") {
            tokens.push({ kind: "rparen", pos: i });
            i++;
            continue;
        }
        if (c === "+") {
            tokens.push({ kind: "plus", pos: i });
            i++;
            continue;
        }
        if (c === "-") {
            tokens.push({ kind: "minus", pos: i });
            i++;
            continue;
        }
        if (c === "&") {
            tokens.push({ kind: "and", pos: i });
            i++;
            continue;
        }
        if (/[a-zA-Z0-9_*]/.test(c)) {
            const start = i;
            while (i < src.length && /[a-zA-Z0-9_*]/.test(src[i])) {
                i++;
            }
            tokens.push({ kind: "bareword", value: src.slice(start, i), pos: start });
            continue;
        }
        throw new Error(`unexpected character ${JSON.stringify(c)} at position ${i}`);
    }
    tokens.push({ kind: "end", pos: src.length });
    return tokens;
}

/**
 * Recursive-descent parser. Tokens are consumed positionally; each
 * grammar rule is one method that yields an AST sub-tree.
 */
class Parser {
    private readonly tokens: Token[];
    private readonly src: string;
    private pos = 0;

    constructor(tokens: Token[], src: string) {
        this.tokens = tokens;
        this.src = src;
    }

    parseExpr(): FilterAst {
        return this.parsePlusMinus();
    }

    expectEnd(): void {
        const t = this.peek();
        if (t.kind !== "end") {
            throw new Error(this.errorAt(t.pos, `unexpected ${describe(t)}`));
        }
    }

    private parsePlusMinus(): FilterAst {
        let left = this.parseAnd();
        while (this.peek().kind === "plus" || this.peek().kind === "minus") {
            const op = this.peek().kind;
            this.advance();
            const right = this.parseAnd();
            left = op === "plus" ? { type: "plus", left, right } : { type: "minus", left, right };
        }
        return left;
    }

    private parseAnd(): FilterAst {
        let left = this.parseAtom();
        while (this.peek().kind === "and") {
            this.advance();
            const right = this.parseAtom();
            left = { type: "and", left, right };
        }
        return left;
    }

    private parseAtom(): FilterAst {
        const t = this.peek();
        if (t.kind === "lparen") {
            this.advance();
            const inner = this.parsePlusMinus();
            const close = this.peek();
            if (close.kind !== "rparen") {
                throw new Error(this.errorAt(close.pos, `expected ")"`));
            }
            this.advance();
            return inner;
        }
        if (t.kind === "bareword") {
            this.advance();
            const classified = classifyBareword(t.value);
            return classified.kind === "group"
                ? { type: "group", kind: "group", name: classified.name }
                : { type: "tool", kind: "tool", pattern: classified.pattern };
        }
        throw new Error(this.errorAt(t.pos, `expected group / tool / "(", got ${describe(t)}`));
    }

    private peek(): Token {
        return this.tokens[this.pos] as Token;
    }

    private advance(): void {
        this.pos++;
    }

    private errorAt(pos: number, message: string): string {
        return `${message} at position ${pos} in ${JSON.stringify(this.src)}`;
    }
}

/** Recursive evaluator with a `visiting` set for cycle detection. */
function evalNode(
    node: FilterAst,
    available: ReadonlySet<string>,
    lookup: GroupLookup,
    builtins: ReadonlyMap<string, ReadonlySet<string>>,
    visiting: Set<string>,
): Set<string> {
    if (node.type === "plus") {
        const left = evalNode(node.left, available, lookup, builtins, visiting);
        const right = evalNode(node.right, available, lookup, builtins, visiting);
        for (const k of right) {
            left.add(k);
        }
        return left;
    }
    if (node.type === "minus") {
        const left = evalNode(node.left, available, lookup, builtins, visiting);
        const right = evalNode(node.right, available, lookup, builtins, visiting);
        for (const k of right) {
            left.delete(k);
        }
        return left;
    }
    if (node.type === "and") {
        const left = evalNode(node.left, available, lookup, builtins, visiting);
        const right = evalNode(node.right, available, lookup, builtins, visiting);
        const out = new Set<string>();
        for (const k of left) {
            if (right.has(k)) {
                out.add(k);
            }
        }
        return out;
    }
    if (node.type === "group") {
        return resolveGroup(node.name, available, lookup, builtins, visiting);
    }
    return matchTools(node.pattern, available);
}

/**
 * Resolve a group reference. Built-ins (`all`, `none`, `system`,
 * `mcp`, plus per-MCP-id auto-groups) are short-circuited before
 * any user lookup; user-defined groups are loaded lazily through
 * `lookup`.
 */
function resolveGroup(
    name: string,
    available: ReadonlySet<string>,
    lookup: GroupLookup,
    builtins: ReadonlyMap<string, ReadonlySet<string>>,
    visiting: Set<string>,
): Set<string> {
    if (name === ALL_GROUP_NAME) {
        return new Set(available);
    }
    if (name === NONE_GROUP_NAME) {
        return new Set();
    }
    const builtin = builtins.get(name);
    if (builtin !== undefined) {
        return new Set(builtin);
    }
    if (visiting.has(name)) {
        const chain = [...visiting, name].join(" -> ");
        throw new Error(`cycle in group references: ${chain}`);
    }
    const def = lookup(name);
    if (def === undefined) {
        throw new Error(`unknown group: ${name}`);
    }
    visiting.add(name);
    try {
        const out = new Set<string>();
        for (const entry of def) {
            if (entry.kind === "group") {
                for (const k of resolveGroup(entry.name, available, lookup, builtins, visiting)) {
                    out.add(k);
                }
            } else {
                for (const k of matchTools(entry.pattern, available)) {
                    out.add(k);
                }
            }
        }
        return out;
    } finally {
        visiting.delete(name);
    }
}

/**
 * Glob-match a tool pattern against every available key, returning
 * the matches. Patterns without `*` are exact-match; `*` is a
 * wildcard for any character sequence (including `_`, since the
 * keys themselves contain `_`).
 */
function matchTools(pattern: string, available: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    if (!pattern.includes("*")) {
        if (available.has(pattern)) {
            out.add(pattern);
        }
        return out;
    }
    const regex = new RegExp(
        `^${pattern
            .split("*")
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`,
    );
    for (const key of available) {
        if (regex.test(key)) {
            out.add(key);
        }
    }
    return out;
}

/** Trim a `# comment` from end-of-line, returning the prefix. */
function stripComment(line: string): string {
    const idx = line.indexOf("#");
    return idx === -1 ? line : line.slice(0, idx);
}

/** Render a token for error messages. */
function describe(t: Token): string {
    switch (t.kind) {
        case "bareword":
            return JSON.stringify(t.value);
        case "end":
            return "end of expression";
        default:
            return t.kind;
    }
}
