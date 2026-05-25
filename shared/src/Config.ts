/**
 * Plugin-agnostic configuration surface exposed by the host.
 *
 * Plugins reach configuration through `HostContext.config` rather than
 * touching `process.env` or reading the YAML file themselves. The
 * service intentionally has no plugin-specific types; everything is
 * keyed by dotted path strings (e.g. `"core.postgresPassword"`,
 * `"telegram.botToken"`) and validated to a primitive shape at the
 * call site.
 *
 * Required-vs-optional semantics live in the call signature, not in
 * the schema: omitting `defaultValue` makes the read throw on missing
 * or wrong-shaped data, while supplying one widens the return type to
 * include the default (so plugins can pass `null` for fields they
 * tolerate being absent).
 *
 * The platform-level minimum (the keys without which the daemon can't
 * start) is enforced by a separate `ConfigLinter` on the host side at
 * boot. Plugin-side keys are not policed by the platform — plugins own
 * the validation of their own subtrees.
 */
export interface ConfigService {
    /**
     * Read a string under a dotted path. Throws when the key is
     * missing, the resolved value is not a string, or the string is
     * empty.
     */
    getString(key: string): string;
    /**
     * String read with an opt-out default. The return type widens to
     * `string | T` so callers can pass `null` for optional fields and
     * branch on absence without losing type safety.
     */
    getString<T>(key: string, defaultValue: T): string | T;

    /** Number read; same throw-on-missing semantics as {@link getString}. */
    getNumber(key: string): number;
    /** Number read with default; same widening semantics as {@link getString}. */
    getNumber<T>(key: string, defaultValue: T): number | T;

    /**
     * Boolean read. Throws when the key is missing or the resolved
     * value is not a boolean. YAML's native `true` / `false` parse to
     * booleans, so a stanza like `inference.captureModelHttpRequestBodies: true` reads
     * back as `true` here.
     */
    getBool(key: string): boolean;
    /** Boolean read with default; widening as above. */
    getBool<T>(key: string, defaultValue: T): boolean | T;

    /**
     * Array read. Element types are not validated — the caller checks
     * shape if it cares (e.g. `.filter((x): x is string => typeof x === "string")`).
     * Throws when the key is missing or the resolved value is not an
     * array.
     */
    getArray(key: string): readonly unknown[];
    /** Array read with default; widening as above. */
    getArray<T>(key: string, defaultValue: T): readonly unknown[] | T;

    /**
     * Read a "string or list of strings" config value as a normalized
     * `string[]`. A bare string becomes a one-element list; an array is
     * filtered down to its non-empty string members; anything else (or
     * a missing key) falls back to `defaultValue`. Lets the operator
     * write either `key: foo/**` or `key: ["foo/**", "bar/*"]` and have
     * both read back the same way.
     *
     * Distinct from {@link getArray}, which returns the default (losing
     * the value) when the config holds a bare string rather than an
     * array.
     */
    getStringList(key: string, defaultValue: readonly string[]): readonly string[];

    /**
     * Set a single dotted-path key and persist atomically (write
     * temp + rename). Creates intermediate maps as needed.
     *
     * `value` may be any YAML-serializable primitive, array, or plain
     * object. The implementation re-reads from disk before patching
     * so concurrent writes from another process don't get clobbered
     * silently.
     *
     * @throws If the value cannot be serialized as YAML, or if the
     *   atomic write fails.
     */
    set(key: string, value: unknown): Promise<void>;
}
