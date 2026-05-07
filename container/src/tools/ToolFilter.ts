/**
 * Per-handler tool-filter DSL: parser, AST, and evaluator.
 *
 * Expression grammar (recursive descent):
 *
 *     expr        := or
 *     or          := and ('||' and)*
 *     and         := unary ('&&' unary)*
 *     unary       := '!' unary | atom
 *     atom        := bareword | '(' expr ')'
 *
 *     bareword    := [a-zA-Z0-9_*-]+
 *
 * Precedence: `!` > `&&` > `||`. Whitespace insignificant.
 *
 * **One atom shape for both groups and tool patterns.** A bareword
 * is classified at evaluation time by regex:
 *
 * - matches `^[a-z][a-z0-9-]*$` (i.e. lowercase ident, no `_`, no `*`)
 *   → **group** lookup (throws on missing).
 * - anything else → **tool pattern** matched against the pool's
 *   namespaced keys with `*` as a glob wildcard.
 *
 * Tool keys always have the form `${id}_${name}`, and our id regex
 * forbids `_`, so every tool key contains at least one underscore.
 * That makes the split structurally unambiguous: an underscore-free
 * lowercase bareword can never match a tool key, so it must be a
 * group reference.
 *
 * Built-in groups handled by the evaluator: `all` resolves to the
 * full set of available pool keys at evaluation time. A user-defined
 * group named `all` is rejected by {@link ToolGroupLoader}, so the
 * built-in always wins.
 */

/** Built-in group name; resolves to every available namespaced tool. */
export const ALL_GROUP_NAME = "all";

/** Pattern an identifier (group name) must match. */
export const IDENT_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Pattern any single bareword (group or tool) must match. */
const BAREWORD_PATTERN = /^[a-zA-Z0-9_*-]+$/;

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

/** AST node returned by {@link parseExpression} and consumed by {@link evaluate}. */
export type FilterAst =
    | { readonly type: "or"; readonly left: FilterAst; readonly right: FilterAst }
    | { readonly type: "and"; readonly left: FilterAst; readonly right: FilterAst }
    | { readonly type: "not"; readonly child: FilterAst }
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
    | { kind: "or"; pos: number }
    | { kind: "not"; pos: number }
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
        if (/[a-zA-Z0-9_*-]/.test(c)) {
            const start = i;
            while (i < src.length && /[a-zA-Z0-9_*-]/.test(src[i])) {
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
    return matchTools(node.pattern, available);
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
