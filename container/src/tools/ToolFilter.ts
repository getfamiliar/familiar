/**
 * Per-handler tool-filter DSL: parser, AST, and evaluator.
 *
 * Expression grammar (recursive descent):
 *
 *     expr        := or
 *     or          := and ('||' and)*
 *     and         := unary ('&&' unary)*
 *     unary       := '!' unary | atom
 *     atom        := group | path | '(' expr ')'
 *     group       := IDENT
 *     path        := '/' SEGMENT ('/' SEGMENT)?
 *
 *     IDENT       := [a-z][a-z0-9-]*
 *     SEGMENT     := [a-zA-Z0-9_*-]+
 *
 * Precedence: `!` > `&&` > `||`. Whitespace insignificant.
 *
 * Paths address the bastion's namespaced tool keys. The pool registers
 * tools as `${id}_${name}` (AI-SDK convention); `/${id}/${name}` is the
 * filter-syntax form. The translation lives in {@link matchPath}.
 *
 * Built-in groups handled by the evaluator: `all` resolves to the full
 * set of available pool keys at evaluation time. A user-defined group
 * named `all` is rejected by {@link ToolGroupLoader}, so the built-in
 * always wins.
 */

/** Built-in group name; resolves to every available namespaced tool. */
export const ALL_GROUP_NAME = "all";

/** Pattern an identifier (group name) must match. */
export const IDENT_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Pattern a path segment (id or tool) must match. */
const SEGMENT_PATTERN = /^[a-zA-Z0-9_*-]+$/;

/** A path entry: either a whole MCP id, or a specific tool with optional `*` glob. */
export interface PathEntry {
    readonly kind: "path";
    readonly id: string;
    readonly tool?: string;
}

/** A group reference inside an AST node or a group file line. */
export interface GroupEntry {
    readonly kind: "group";
    readonly name: string;
}

/** One entry in a group file (post-parse). Used by {@link ToolGroupLoader}. */
export type GroupLineEntry = PathEntry | GroupEntry;

/** A `GroupDef` is the ordered list of entries declared in a group's `.txt` file. */
export type GroupDef = readonly GroupLineEntry[];

/** AST node returned by {@link parseExpression} and consumed by {@link evaluate}. */
export type FilterAst =
    | { readonly type: "or"; readonly left: FilterAst; readonly right: FilterAst }
    | { readonly type: "and"; readonly left: FilterAst; readonly right: FilterAst }
    | { readonly type: "not"; readonly child: FilterAst }
    | (GroupEntry & { readonly type: "group" })
    | (PathEntry & { readonly type: "path" });

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
    if (stripped.startsWith("/")) {
        return parsePathToken(stripped);
    }
    if (!IDENT_PATTERN.test(stripped)) {
        throw new Error(`expected an identifier or "/path", got ${JSON.stringify(stripped)}`);
    }
    return { kind: "group", name: stripped };
}

/**
 * Evaluate a parsed expression against a snapshot of available tool
 * keys plus the loaded group definitions. Returns the filtered set.
 *
 * @param ast Parsed expression tree from {@link parseExpression}.
 * @param available Every namespaced tool key the pool currently
 *   exposes (`${id}_${name}` form).
 * @param groups Map of group name → ordered entries; built by
 *   {@link ToolGroupLoader.loadGroups}.
 * @throws On unknown groups or cycles in the group reference chain.
 */
export function evaluate(
    ast: FilterAst,
    available: ReadonlySet<string>,
    groups: ReadonlyMap<string, GroupDef>,
): Set<string> {
    return evalNode(ast, available, groups, new Set());
}

/**
 * Lightweight tokenizer. Returns a flat array — the parser consumes
 * positionally. Throws on unexpected characters.
 */
type Token =
    | { kind: "lparen"; pos: number }
    | { kind: "rparen"; pos: number }
    | { kind: "and"; pos: number }
    | { kind: "or"; pos: number }
    | { kind: "not"; pos: number }
    | { kind: "ident"; value: string; pos: number }
    | { kind: "path"; id: string; tool?: string; pos: number }
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
        if (c === "!") {
            tokens.push({ kind: "not", pos: i });
            i++;
            continue;
        }
        if (c === "&") {
            if (src[i + 1] !== "&") {
                throw new Error(`expected "&&" at position ${i}`);
            }
            tokens.push({ kind: "and", pos: i });
            i += 2;
            continue;
        }
        if (c === "|") {
            if (src[i + 1] !== "|") {
                throw new Error(`expected "||" at position ${i}`);
            }
            tokens.push({ kind: "or", pos: i });
            i += 2;
            continue;
        }
        if (c === "/") {
            const start = i;
            i++;
            const id = readSegment(src, i);
            i += id.length;
            let tool: string | undefined;
            if (src[i] === "/") {
                i++;
                tool = readSegment(src, i);
                i += tool.length;
            }
            if (id.length === 0) {
                throw new Error(`empty path at position ${start}`);
            }
            tokens.push({ kind: "path", id, tool, pos: start });
            continue;
        }
        if (/[a-z]/.test(c)) {
            const start = i;
            while (i < src.length && /[a-z0-9-]/.test(src[i])) {
                i++;
            }
            tokens.push({ kind: "ident", value: src.slice(start, i), pos: start });
            continue;
        }
        throw new Error(`unexpected character ${JSON.stringify(c)} at position ${i}`);
    }
    tokens.push({ kind: "end", pos: src.length });
    return tokens;
}

/** Consume characters of a path segment starting at `i`. */
function readSegment(src: string, i: number): string {
    let j = i;
    while (j < src.length && /[a-zA-Z0-9_*-]/.test(src[j])) {
        j++;
    }
    return src.slice(i, j);
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
        return this.parseOr();
    }

    expectEnd(): void {
        const t = this.peek();
        if (t.kind !== "end") {
            throw new Error(this.errorAt(t.pos, `unexpected ${describe(t)}`));
        }
    }

    private parseOr(): FilterAst {
        let left = this.parseAnd();
        while (this.peek().kind === "or") {
            this.advance();
            const right = this.parseAnd();
            left = { type: "or", left, right };
        }
        return left;
    }

    private parseAnd(): FilterAst {
        let left = this.parseUnary();
        while (this.peek().kind === "and") {
            this.advance();
            const right = this.parseUnary();
            left = { type: "and", left, right };
        }
        return left;
    }

    private parseUnary(): FilterAst {
        if (this.peek().kind === "not") {
            this.advance();
            return { type: "not", child: this.parseUnary() };
        }
        return this.parseAtom();
    }

    private parseAtom(): FilterAst {
        const t = this.peek();
        if (t.kind === "lparen") {
            this.advance();
            const inner = this.parseOr();
            const close = this.peek();
            if (close.kind !== "rparen") {
                throw new Error(this.errorAt(close.pos, `expected ")"`));
            }
            this.advance();
            return inner;
        }
        if (t.kind === "ident") {
            this.advance();
            return { type: "group", kind: "group", name: t.value };
        }
        if (t.kind === "path") {
            this.advance();
            return { type: "path", kind: "path", id: t.id, tool: t.tool };
        }
        throw new Error(this.errorAt(t.pos, `expected group / path / "(", got ${describe(t)}`));
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
    groups: ReadonlyMap<string, GroupDef>,
    visiting: Set<string>,
): Set<string> {
    if (node.type === "or") {
        const left = evalNode(node.left, available, groups, visiting);
        const right = evalNode(node.right, available, groups, visiting);
        for (const k of right) {
            left.add(k);
        }
        return left;
    }
    if (node.type === "and") {
        const left = evalNode(node.left, available, groups, visiting);
        const right = evalNode(node.right, available, groups, visiting);
        const out = new Set<string>();
        for (const k of left) {
            if (right.has(k)) {
                out.add(k);
            }
        }
        return out;
    }
    if (node.type === "not") {
        const inner = evalNode(node.child, available, groups, visiting);
        const out = new Set<string>();
        for (const k of available) {
            if (!inner.has(k)) {
                out.add(k);
            }
        }
        return out;
    }
    if (node.type === "group") {
        return resolveGroup(node.name, available, groups, visiting);
    }
    return matchPaths(node, available);
}

/** Resolve a group reference, recursively unioning its entries. */
function resolveGroup(
    name: string,
    available: ReadonlySet<string>,
    groups: ReadonlyMap<string, GroupDef>,
    visiting: Set<string>,
): Set<string> {
    if (name === ALL_GROUP_NAME) {
        return new Set(available);
    }
    if (visiting.has(name)) {
        const chain = [...visiting, name].join(" -> ");
        throw new Error(`cycle in group references: ${chain}`);
    }
    const def = groups.get(name);
    if (def === undefined) {
        throw new Error(`unknown group: ${name}`);
    }
    visiting.add(name);
    try {
        const out = new Set<string>();
        for (const entry of def) {
            if (entry.kind === "group") {
                for (const k of resolveGroup(entry.name, available, groups, visiting)) {
                    out.add(k);
                }
            } else {
                for (const k of matchPaths(entry, available)) {
                    out.add(k);
                }
            }
        }
        return out;
    } finally {
        visiting.delete(name);
    }
}

/** Match a path entry against every available key, returning hits. */
function matchPaths(path: PathEntry, available: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    for (const key of available) {
        if (matchPath(path, key)) {
            out.add(key);
        }
    }
    return out;
}

/**
 * Test one namespaced key against one path entry. Splits the key on
 * the first `_` to recover the id; the remainder is the tool name.
 * Path id matches literally; path tool matches by glob (`*` allowed
 * anywhere in the tool segment) when present, otherwise matches all
 * tools on that id.
 */
export function matchPath(path: PathEntry, key: string): boolean {
    const idx = key.indexOf("_");
    if (idx === -1) {
        return false;
    }
    if (key.slice(0, idx) !== path.id) {
        return false;
    }
    if (path.tool === undefined) {
        return true;
    }
    return matchGlob(path.tool, key.slice(idx + 1));
}

/** Convert a glob with `*` wildcards into a regex test (anchored). */
function matchGlob(pattern: string, str: string): boolean {
    if (!pattern.includes("*")) {
        return pattern === str;
    }
    const escaped = pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${escaped}$`).test(str);
}

/** Trim a `# comment` from end-of-line, returning the prefix. */
function stripComment(line: string): string {
    const idx = line.indexOf("#");
    return idx === -1 ? line : line.slice(0, idx);
}

/**
 * Parse a single token like `/atlassian/jira_*` into a {@link PathEntry}.
 * Used by both the expression tokenizer and the group-line parser.
 */
function parsePathToken(token: string): PathEntry {
    if (!token.startsWith("/")) {
        throw new Error(`path must start with "/": ${JSON.stringify(token)}`);
    }
    const parts = token.slice(1).split("/");
    if (parts.length === 0 || parts.length > 2) {
        throw new Error(`path must be /<id> or /<id>/<tool>: ${JSON.stringify(token)}`);
    }
    const [id, tool] = parts;
    if (!SEGMENT_PATTERN.test(id)) {
        throw new Error(`invalid id segment in ${JSON.stringify(token)}`);
    }
    if (tool !== undefined && !SEGMENT_PATTERN.test(tool)) {
        throw new Error(`invalid tool segment in ${JSON.stringify(token)}`);
    }
    return { kind: "path", id, tool };
}

/** Render a token for error messages. */
function describe(t: Token): string {
    switch (t.kind) {
        case "ident":
            return JSON.stringify(t.value);
        case "path":
            return `/${t.id}${t.tool === undefined ? "" : `/${t.tool}`}`;
        case "end":
            return "end of expression";
        default:
            return t.kind;
    }
}
