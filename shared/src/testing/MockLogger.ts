import type { Logger, LogLevel } from "../logging/Logger.js";

/**
 * One captured log call. `obj` is whatever the caller passed as the
 * structured payload (an object or `undefined` for plain-message
 * variants); `msg` is the rendered message string.
 */
export interface MockLogEntry {
    readonly level: LogLevel;
    readonly msg: string;
    readonly obj: object | undefined;
    /**
     * Accumulated child-logger bindings. A root logger has no bindings;
     * a child via `.child({ component: 'x' })` adds `{ component: 'x' }`.
     */
    readonly bindings: ReadonlyArray<Record<string, unknown>>;
}

/**
 * In-memory {@link Logger} that records every call into a flat
 * {@link entries} array, suitable for assertions in unit tests.
 *
 * Children share the same backing entries array and accumulate
 * bindings — so `logger.child({ a: 1 }).child({ b: 2 }).info('hi')`
 * records `{ bindings: [{a:1}, {b:2}], msg: 'hi', ... }`.
 *
 * Lives in `shared/` because every package that depends on
 * `@getfamiliar/shared` already has the `Logger` interface visible,
 * and the same mock works for host- and container-side tests.
 */
export class MockLogger implements Logger {
    /** Every call observed by this logger (and its children). */
    readonly entries: MockLogEntry[] = [];
    private readonly bindings: ReadonlyArray<Record<string, unknown>>;

    constructor(bindings: ReadonlyArray<Record<string, unknown>> = []) {
        this.bindings = bindings;
    }

    debug(obj: object, msg?: string): void;
    debug(msg: string): void;
    debug(a: object | string, b?: string): void {
        this.record("debug", a, b);
    }

    info(obj: object, msg?: string): void;
    info(msg: string): void;
    info(a: object | string, b?: string): void {
        this.record("info", a, b);
    }

    warn(obj: object, msg?: string): void;
    warn(msg: string): void;
    warn(a: object | string, b?: string): void {
        this.record("warn", a, b);
    }

    error(obj: object, msg?: string): void;
    error(msg: string): void;
    error(a: object | string, b?: string): void {
        this.record("error", a, b);
    }

    child(bindings: Record<string, unknown>): Logger {
        const child = new MockLogger([...this.bindings, bindings]);
        // Share the entries array so parent observations see child
        // writes too — matches `pino.child` semantics from the test's
        // POV.
        (child as { entries: MockLogEntry[] }).entries = this.entries;
        return child;
    }

    /**
     * Convenience query: does an entry at `level` with a message
     * matching `match` exist? `match` is either a substring or a
     * RegExp.
     */
    hasEntry(level: LogLevel, match: string | RegExp): boolean {
        return this.entries.some(
            (e) =>
                e.level === level &&
                (typeof match === "string" ? e.msg.includes(match) : match.test(e.msg)),
        );
    }

    /** Drop all recorded entries. Useful between assertions. */
    clear(): void {
        this.entries.length = 0;
    }

    private record(level: LogLevel, a: object | string, b: string | undefined): void {
        if (typeof a === "string") {
            this.entries.push({ level, msg: a, obj: undefined, bindings: this.bindings });
            return;
        }
        this.entries.push({
            level,
            msg: b ?? "",
            obj: a,
            bindings: this.bindings,
        });
    }
}
