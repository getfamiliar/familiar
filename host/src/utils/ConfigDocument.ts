import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isMap, isPair, isScalar, isSeq, parseDocument, stringify, type YAMLMap } from "yaml";

/**
 * Comment-preserving edits of `config.yml`.
 *
 * Two flavours:
 *
 * - **Surgical text edits** ({@link insertMapEntry}, {@link removeMapEntry})
 *   splice one entry into / out of a block mapping using the parser's
 *   source ranges. Everything outside the touched lines stays byte for
 *   byte identical — used by `familiar storage add|remove`.
 * - **Document edits** ({@link setConfigValue}) go through the `yaml`
 *   Document API, which keeps comments but may normalize whitespace of
 *   the re-rendered document — used by `ConfigService.set`.
 */

/**
 * Insert `key: value` as the last entry of the block mapping at
 * `mapPath` (e.g. `["storage", "mounts"]`), creating missing parent
 * mappings at the end of their parent.
 *
 * @param text - Current file content.
 * @param mapPath - Dotted path segments of the target mapping.
 * @param key - Entry key.
 * @param value - Entry value (rendered as block YAML).
 * @returns The new file content.
 * @throws Error when the key exists or a path segment is not a block mapping.
 */
export function insertMapEntry(
    text: string,
    mapPath: readonly string[],
    key: string,
    value: unknown,
): string {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) {
        throw new Error(`config is not valid YAML: ${doc.errors[0]?.message}`);
    }
    // Find the deepest existing mapping along the path.
    let node: unknown = doc.contents;
    let depth = 0;
    let parentKeyNode: { range?: [number, number, number] | null } | null = null;
    for (const segment of mapPath) {
        if (!isMap(node)) {
            break;
        }
        const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === segment);
        if (!pair) {
            break;
        }
        if (
            pair.value !== null &&
            !isMap(pair.value) &&
            !(isScalar(pair.value) && pair.value.value === null)
        ) {
            throw new Error(
                `\`${mapPath.slice(0, depth + 1).join(".")}\` is not a mapping — edit config.yml by hand`,
            );
        }
        parentKeyNode = pair.key as { range?: [number, number, number] | null };
        node = pair.value;
        depth++;
        if (!isMap(node)) {
            break;
        }
    }

    const missing = [...mapPath.slice(depth), key];
    if (depth === mapPath.length && isMap(node)) {
        if (node.flow) {
            throw new Error(
                `\`${mapPath.join(".")}\` is a flow mapping ({…}) — rewrite it as a block mapping first`,
            );
        }
        if (node.items.some((p) => isScalar(p.key) && String(p.key.value) === key)) {
            throw new Error(`\`${[...mapPath, key].join(".")}\` already exists`);
        }
    }

    if (depth === 0) {
        // Nothing of the path exists: append at the end of the document.
        const block = renderNested(missing, value, 0);
        const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
        return `${text}${sep}${block}`;
    }

    if (isMap(node) && node.items.length > 0) {
        const indent = columnOf(text, rangeStart(node.items[0]?.key));
        const insertAt = lineEnd(text, mapEnd(node));
        return splice(text, insertAt, renderNested(missing.slice(0), value, indent));
    }

    // Parent key exists but its value is empty (`mounts:` with nothing
    // below): nest under it, two spaces deeper than the key.
    const keyStart = rangeStart(parentKeyNode);
    const indent = columnOf(text, keyStart) + 2;
    const insertAt = lineEnd(text, keyStart);
    return splice(text, insertAt, renderNested(missing, value, indent));
}

/**
 * Remove the entry `key` from the block mapping at `mapPath`, deleting
 * exactly the lines it occupies.
 *
 * @returns The new file content.
 * @throws Error when the entry does not exist.
 */
export function removeMapEntry(text: string, mapPath: readonly string[], key: string): string {
    const doc = parseDocument(text);
    const node = doc.getIn(mapPath, true);
    if (!isMap(node)) {
        throw new Error(`\`${mapPath.join(".")}\` does not exist`);
    }
    const index = node.items.findIndex((p) => isScalar(p.key) && String(p.key.value) === key);
    const pair = node.items[index];
    if (!pair || !isPair(pair)) {
        throw new Error(`\`${[...mapPath, key].join(".")}\` does not exist`);
    }
    if (node.flow) {
        throw new Error(
            `\`${mapPath.join(".")}\` is a flow mapping ({…}) — edit config.yml by hand`,
        );
    }
    const start = lineStart(text, rangeStart(pair.key));
    const next = node.items[index + 1];
    const end =
        next !== undefined
            ? lineStart(text, rangeStart(next.key))
            : lineEnd(text, valueEnd(pair.value) ?? rangeStart(pair.key));
    return text.slice(0, start) + text.slice(end);
}

/**
 * Set a dotted-path value through the `yaml` Document API, keeping
 * comments.
 *
 * @param text - Current file content.
 * @param key - Dotted path, e.g. `telegram.chatId`.
 * @param value - New value.
 * @returns The new file content.
 */
export function setConfigValue(text: string, key: string, value: unknown): string {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) {
        throw new Error(`config is not valid YAML: ${doc.errors[0]?.message}`);
    }
    if (doc.contents === null) {
        // An empty file has no root mapping yet.
        (doc as { contents: unknown }).contents = doc.createNode({});
    }
    const path = key.split(".");
    // Keep the collection style of the value being replaced (`[a, b]` stays flow).
    const existing = doc.getIn(path, true);
    const isFlow = (isSeq(existing) || isMap(existing)) && existing.flow === true;
    const node = doc.createNode(value, { flow: isFlow });
    // Carry over comments attached to the replaced value (`key: [..] # note`).
    const previous = existing as
        | { comment?: string | null; commentBefore?: string | null }
        | undefined;
    if (previous && typeof previous === "object") {
        node.comment = previous.comment ?? node.comment;
        node.commentBefore = previous.commentBefore ?? node.commentBefore;
    }
    doc.setIn(path, node);
    return doc.toString();
}

/**
 * Write `text` atomically (temp file + rename), then run `validate`; on
 * a validation error restore the previous content and rethrow.
 *
 * @param filePath - Target file.
 * @param text - New content.
 * @param validate - Throws when the written file is not acceptable.
 */
export function writeConfigAtomically(filePath: string, text: string, validate?: () => void): void {
    const previous = readFileSync(filePath, "utf-8");
    const tmp = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmp, text, "utf-8");
    try {
        renameSync(tmp, filePath);
    } catch (err) {
        unlinkSync(tmp);
        throw err;
    }
    if (!validate) {
        return;
    }
    try {
        validate();
    } catch (err) {
        writeFileSync(filePath, previous, "utf-8");
        throw err;
    }
}

/** Render `a: { b: { key: value } }` as indented block YAML ending in a newline. */
function renderNested(path: readonly string[], value: unknown, indent: number): string {
    let nested: unknown = value;
    for (let i = path.length - 1; i >= 0; i--) {
        nested = { [path[i] as string]: nested };
    }
    const block = stringify(nested, { indent: 2, lineWidth: 0 });
    const pad = " ".repeat(indent);
    return block
        .split("\n")
        .map((line) => (line.length > 0 ? pad + line : line))
        .join("\n");
}

/** Offset of the end of a mapping's last value. */
function mapEnd(node: YAMLMap): number {
    const last = node.items[node.items.length - 1];
    return valueEnd(last?.value) ?? rangeStart(last?.key);
}

function valueEnd(node: unknown): number | undefined {
    const range = (node as { range?: [number, number, number] | null } | null)?.range;
    return range ? range[1] : undefined;
}

function rangeStart(node: unknown): number {
    const range = (node as { range?: [number, number, number] | null } | null)?.range;
    if (!range) {
        throw new Error("YAML node without source range");
    }
    return range[0];
}

/** Column (0-based) of `offset` within its line. */
function columnOf(text: string, offset: number): number {
    return offset - lineStart(text, offset);
}

function lineStart(text: string, offset: number): number {
    return text.lastIndexOf("\n", offset - 1) + 1;
}

/** Offset just past the newline ending the line that contains `offset` (a value end may sit on that newline). */
function lineEnd(text: string, offset: number): number {
    const probe = offset > 0 && text[offset - 1] === "\n" ? offset - 1 : offset;
    const nl = text.indexOf("\n", probe);
    return nl < 0 ? text.length : nl + 1;
}

/** Insert `insert` at `offset`, making sure it starts on a fresh line. */
function splice(text: string, offset: number, insert: string): string {
    const needsNewline = offset > 0 && text[offset - 1] !== "\n";
    return `${text.slice(0, offset)}${needsNewline ? "\n" : ""}${insert}${text.slice(offset)}`;
}
