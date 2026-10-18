/**
 * Leaf-level diff of two parsed `config.yml` trees. Mappings are walked;
 * everything else (scalars, arrays, `null`) is a leaf compared by its
 * JSON form. Added or removed groups report their leaves; a key that
 * turns from a leaf into a mapping (or back) is reported at the
 * shallower path.
 *
 * @param previous Config tree before the change.
 * @param current Config tree after the change.
 * @returns Sorted dotted paths whose value was added, removed or changed.
 */
export function diffConfigLeaves(
    previous: Readonly<Record<string, unknown>>,
    current: Readonly<Record<string, unknown>>,
): string[] {
    const changed: string[] = [];
    collectChanges(previous, current, "", changed);
    return changed.sort();
}

/**
 * Whether `key` lies at or below `prefix` in dotted-path terms
 * (`mail.allowSend` is within `mail`, `mailbox` is not).
 *
 * @param key Dotted path to test.
 * @param prefix Dotted path of the subtree.
 * @returns `true` when `key` equals `prefix` or starts with `prefix.`.
 */
export function isConfigKeyWithin(key: string, prefix: string): boolean {
    return key === prefix || key.startsWith(`${prefix}.`);
}

/**
 * Whether `key` touches the subtree at `prefix` in either direction:
 * `key` lies within `prefix`, or `prefix` lies within `key` (a whole
 * group added or removed is reported at the group's path).
 *
 * @param key Changed dotted path.
 * @param prefix Dotted path of the subtree.
 * @returns `true` when the change affects `prefix`.
 */
export function isConfigKeyOverlapping(key: string, prefix: string): boolean {
    return isConfigKeyWithin(key, prefix) || isConfigKeyWithin(prefix, key);
}

/** Recursive worker for {@link diffConfigLeaves}. */
function collectChanges(previous: unknown, current: unknown, path: string, out: string[]): void {
    // An added or removed group is walked against an empty mapping so its
    // leaves are reported individually (`telegram.botToken`, not `telegram`).
    const before = previous === undefined && isMapping(current) ? {} : previous;
    const after = current === undefined && isMapping(previous) ? {} : current;
    if (isMapping(before) && isMapping(after)) {
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        for (const key of keys) {
            collectChanges(before[key], after[key], path ? `${path}.${key}` : key, out);
        }
        return;
    }
    if (JSON.stringify(before) !== JSON.stringify(after) && path.length > 0) {
        out.push(path);
    }
}

/** Whether `value` is a plain (non-array) mapping. */
function isMapping(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
