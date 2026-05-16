import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConfigService } from "@getfamiliar/shared";
import { parse, stringify, YAMLParseError } from "yaml";

/**
 * Host-side {@link ConfigService} backed by `config/config.yml`.
 *
 * One instance per CLI invocation. The file is parsed eagerly in the
 * constructor so a malformed YAML file fails fast with a clear error
 * — callers don't have to bail out individually on every read.
 *
 * The in-memory state is kept as a plain `Record<string, unknown>`
 * so that arbitrary plugin subtrees pass through unmodified. All
 * shape validation happens at the read site (`getString` /
 * `getNumber` / `getArray`) or in the separate {@link
 * ./ConfigLinter}.
 *
 * Writes go through `set()`, which re-reads the file before patching
 * — this avoids clobbering concurrent edits from another process
 * (e.g. a hand-edit while the daemon is running).
 */
export class HostConfigService implements ConfigService {
    private readonly filePath: string;
    private state: Record<string, unknown> | undefined;

    /**
     * Construction is deliberately cheap and side-effect-free: the
     * file is parsed on first read, not here. This keeps `--help`
     * and other introspective CLI paths working on fresh checkouts
     * that haven't been configured yet — failure surfaces only when
     * a command actually needs a value.
     *
     * @param filePath Absolute path to `config/config.yml`.
     */
    constructor(filePath: string) {
        this.filePath = filePath;
    }

    getString(key: string): string;
    getString<T>(key: string, defaultValue: T): string | T;
    getString<T>(key: string, ...rest: [] | [defaultValue: T]): string | T {
        const value = readPath(this.ensureLoaded(), key);
        if (typeof value === "string" && value.length > 0) {
            return value;
        }
        if (rest.length > 0) {
            return rest[0] as T;
        }
        throw missingError(key, "non-empty string", value);
    }

    getNumber(key: string): number;
    getNumber<T>(key: string, defaultValue: T): number | T;
    getNumber<T>(key: string, ...rest: [] | [defaultValue: T]): number | T {
        const value = readPath(this.ensureLoaded(), key);
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
        if (rest.length > 0) {
            return rest[0] as T;
        }
        throw missingError(key, "finite number", value);
    }

    getBool(key: string): boolean;
    getBool<T>(key: string, defaultValue: T): boolean | T;
    getBool<T>(key: string, ...rest: [] | [defaultValue: T]): boolean | T {
        const value = readPath(this.ensureLoaded(), key);
        if (typeof value === "boolean") {
            return value;
        }
        if (rest.length > 0) {
            return rest[0] as T;
        }
        throw missingError(key, "boolean", value);
    }

    getArray(key: string): readonly unknown[];
    getArray<T>(key: string, defaultValue: T): readonly unknown[] | T;
    getArray<T>(key: string, ...rest: [] | [defaultValue: T]): readonly unknown[] | T {
        const value = readPath(this.ensureLoaded(), key);
        if (Array.isArray(value)) {
            return value;
        }
        if (rest.length > 0) {
            return rest[0] as T;
        }
        throw missingError(key, "array", value);
    }

    /**
     * Read a YAML mapping under a dotted path. Returns the raw record
     * so callers can enumerate keys (e.g. listing every configured
     * provider under `inference.apiKeys.*`). Values are untyped — the
     * caller validates each one.
     *
     * Host-only on purpose: plugins reach config via the shared
     * `ConfigService` interface, which deliberately omits this. If a
     * plugin needs sub-tree enumeration we widen the interface.
     */
    getMapping(key: string): Readonly<Record<string, unknown>>;
    getMapping<T>(key: string, defaultValue: T): Readonly<Record<string, unknown>> | T;
    getMapping<T>(
        key: string,
        ...rest: [] | [defaultValue: T]
    ): Readonly<Record<string, unknown>> | T {
        const value = readPath(this.ensureLoaded(), key);
        if (
            value !== null &&
            value !== undefined &&
            typeof value === "object" &&
            !Array.isArray(value)
        ) {
            return value as Record<string, unknown>;
        }
        if (rest.length > 0) {
            return rest[0] as T;
        }
        throw missingError(key, "mapping", value);
    }

    /**
     * Set a single dotted-path key and persist atomically. Re-reads
     * from disk first so that concurrent hand-edits aren't silently
     * overwritten on the unmodified portion of the file.
     */
    async set(key: string, value: unknown): Promise<void> {
        const fresh = readAndParse(this.filePath);
        writePath(fresh, key, value);
        await persist(this.filePath, fresh);
        this.state = fresh;
    }

    /**
     * Lazy file load. Subsequent calls return the cached state. A
     * single read failure is final for the lifetime of the service —
     * if the file is fixed at runtime, the daemon should be restarted.
     */
    private ensureLoaded(): Record<string, unknown> {
        if (this.state === undefined) {
            this.state = readAndParse(this.filePath);
        }
        return this.state;
    }
}

/**
 * Read and YAML-parse the config file. Returns an empty mapping when
 * the file is empty (a freshly-touched file shouldn't blow up reads —
 * the linter will flag missing required keys separately).
 *
 * @throws If the file is missing, unreadable, or malformed.
 */
function readAndParse(filePath: string): Record<string, unknown> {
    let raw: string;
    try {
        raw = readFileSync(filePath, "utf-8");
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read config file ${filePath}: ${cause}`);
    }
    let parsed: unknown;
    try {
        parsed = parse(raw);
    } catch (err) {
        if (err instanceof YAMLParseError) {
            throw new Error(`Failed to parse ${filePath}: ${err.message}`);
        }
        throw err;
    }
    if (parsed === null || parsed === undefined) {
        return {};
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Config root in ${filePath} must be a YAML mapping.`);
    }
    return parsed as Record<string, unknown>;
}

/**
 * Walk a dotted path through an object tree. Returns `undefined` as
 * soon as a segment is missing or hits a non-object intermediate.
 * Leaves shape validation to the caller.
 */
function readPath(root: Record<string, unknown>, path: string): unknown {
    const segments = path.split(".");
    let cursor: unknown = root;
    for (const seg of segments) {
        if (cursor === null || cursor === undefined) {
            return undefined;
        }
        if (typeof cursor !== "object" || Array.isArray(cursor)) {
            return undefined;
        }
        cursor = (cursor as Record<string, unknown>)[seg];
    }
    return cursor;
}

/**
 * Write `value` into `root` at the dotted path, creating intermediate
 * mappings as needed. Throws if an intermediate already exists as a
 * non-object (e.g. trying to set `core.postgresPassword.foo` when
 * `core.postgresPassword` is a string) — silently overwriting would
 * mask configuration bugs.
 */
function writePath(root: Record<string, unknown>, path: string, value: unknown): void {
    const segments = path.split(".");
    if (segments.length === 0 || segments.some((s) => s.length === 0)) {
        throw new Error(`Invalid config key: ${JSON.stringify(path)}`);
    }
    let cursor: Record<string, unknown> = root;
    for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i] as string;
        const next = cursor[seg];
        if (next === undefined) {
            const fresh: Record<string, unknown> = {};
            cursor[seg] = fresh;
            cursor = fresh;
            continue;
        }
        if (typeof next !== "object" || next === null || Array.isArray(next)) {
            throw new Error(
                `Cannot set ${path}: intermediate ${segments.slice(0, i + 1).join(".")} is not a mapping.`,
            );
        }
        cursor = next as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1] as string] = value;
}

/**
 * Serialize `state` back to YAML and atomically replace the file via
 * write-temp + rename. Atomicity matters because a daemon and an
 * interactive `set` command may both be running.
 */
async function persist(filePath: string, state: Record<string, unknown>): Promise<void> {
    const yaml = stringify(state);
    const tmp = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmp, yaml, "utf-8");
    try {
        renameSync(tmp, filePath);
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(
            `Failed to atomically replace ${filePath} (tmp at ${tmp}, dir ${dirname(filePath)}): ${cause}`,
        );
    }
}

/**
 * Build a clear error for a failed required read. Includes the
 * actual resolved value (when not `undefined`) so misconfigurations
 * are immediately diagnosable from the log line.
 */
function missingError(key: string, expected: string, actual: unknown): Error {
    if (actual === undefined) {
        return new Error(
            `Config key ${key} is not set in config/config.yml (expected ${expected}).`,
        );
    }
    return new Error(
        `Config key ${key} has wrong shape in config/config.yml: expected ${expected}, got ${describe(actual)}.`,
    );
}

/** Compact, log-friendly description of a value's actual runtime shape. */
function describe(value: unknown): string {
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return "array";
    }
    return typeof value;
}
