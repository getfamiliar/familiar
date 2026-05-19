import { existsSync, readFileSync } from "node:fs";
import type { Logger } from "@getfamiliar/shared";
import { parse, YAMLParseError } from "yaml";
import { NATIVE_PROVIDER_IDS } from "../bastion/NativeProviders.js";

/**
 * Result of a config lint pass. `errors` are platform-level
 * showstoppers (the daemon refuses to start if any are present);
 * `warnings` are advisory and tolerated at runtime.
 */
export interface ConfigLintResult {
    readonly ok: boolean;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
}

/**
 * Validate a `config.yml` against the platform-level minimum:
 * file exists, parses as a YAML mapping, and contains the bare keys
 * the daemon needs to start (postgres password, default chat channel,
 * a chosen inference provider with its API key, a default model).
 *
 * **Plugin-specific keys are intentionally not validated here.** The
 * platform doesn't enumerate plugins (no central manifest registry of
 * config schemas), so unknown top-level groups are ignored — they
 * belong to plugins that own their own validation.
 *
 * Pure function: never throws, never logs. Callers decide what to
 * do with the result. See {@link lintOrThrow} for the daemon-boot
 * convenience wrapper.
 */
export function lintConfigFile(path: string): ConfigLintResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!existsSync(path)) {
        errors.push(`Config file not found at ${path}. Copy config/config.example.yml to start.`);
        return { ok: false, errors, warnings };
    }

    let raw: string;
    try {
        raw = readFileSync(path, "utf-8");
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        errors.push(`Cannot read ${path}: ${cause}`);
        return { ok: false, errors, warnings };
    }

    let root: unknown;
    try {
        root = parse(raw);
    } catch (err) {
        const msg = err instanceof YAMLParseError ? err.message : String(err);
        errors.push(`YAML parse error in ${path}: ${msg}`);
        return { ok: false, errors, warnings };
    }

    if (root === null || root === undefined) {
        errors.push(`${path} is empty.`);
        return { ok: false, errors, warnings };
    }
    if (typeof root !== "object" || Array.isArray(root)) {
        errors.push(`Config root in ${path} must be a YAML mapping.`);
        return { ok: false, errors, warnings };
    }

    const config = root as Record<string, unknown>;

    requireString(config, "core.postgresPassword", errors);
    requireString(config, "core.defaultChatChannel", errors);
    const defaultProvider = requireString(config, "inference.defaultProvider", errors);
    requireString(config, "inference.defaultModel", errors);
    lintInferenceProviders(config, defaultProvider, errors);

    optionalPositiveInt(config, "core.logRetentionDays", warnings);
    optionalPositiveInt(config, "core.agentTimeout", warnings);
    optionalBool(config, "core.logSystemPrompt", warnings);
    optionalIanaTimezone(config, "core.timezone", warnings);
    optionalString(config, "core.defaultCalendar", warnings);
    optionalNonNegativeInt(config, "inference.maxRetries", warnings);
    optionalBool(config, "inference.captureModelHttpRequestBodies", warnings);
    optionalBool(config, "inference.captureRawStepResultToDatabase", warnings);

    return { ok: errors.length === 0, errors, warnings };
}

/**
 * Validate the `inference.apiKeys` and `inference.customProviders`
 * subtrees, plus the cross-cutting `defaultProvider` invariant. Native
 * apiKeys must be in the whitelist; custom providers must declare
 * `baseUrl`, `apiKey`, and `type: "openai-compatible"`; their ids must
 * not collide with native ids. The default provider id has to resolve
 * to one of the configured entries.
 */
function lintInferenceProviders(
    root: Record<string, unknown>,
    defaultProvider: string | undefined,
    errors: string[],
): void {
    const apiKeys = readPath(root, "inference.apiKeys");
    const customProviders = readPath(root, "inference.customProviders");

    const apiKeyIds = new Set<string>();
    if (apiKeys !== undefined) {
        if (!isPlainObject(apiKeys)) {
            errors.push(`inference.apiKeys must be a mapping (got ${describe(apiKeys)}).`);
        } else {
            for (const [id, value] of Object.entries(apiKeys)) {
                if (!NATIVE_PROVIDER_IDS.has(id)) {
                    const known = Array.from(NATIVE_PROVIDER_IDS).sort().join(", ");
                    errors.push(
                        `inference.apiKeys.${id}: not a known native provider (allowed: ${known}). Use inference.customProviders.${id} for non-native providers.`,
                    );
                    continue;
                }
                if (typeof value !== "string" || value.length === 0) {
                    errors.push(
                        `inference.apiKeys.${id}: must be a non-empty string (got ${describe(value)}).`,
                    );
                    continue;
                }
                apiKeyIds.add(id);
            }
        }
    }

    const customIds = new Set<string>();
    if (customProviders !== undefined) {
        if (!isPlainObject(customProviders)) {
            errors.push(
                `inference.customProviders must be a mapping (got ${describe(customProviders)}).`,
            );
        } else {
            for (const [id, value] of Object.entries(customProviders)) {
                if (NATIVE_PROVIDER_IDS.has(id)) {
                    errors.push(
                        `inference.customProviders.${id}: id is reserved for the native provider — pick a different id.`,
                    );
                    continue;
                }
                if (!isPlainObject(value)) {
                    errors.push(
                        `inference.customProviders.${id}: must be a mapping (got ${describe(value)}).`,
                    );
                    continue;
                }
                const entry = value as Record<string, unknown>;
                let entryOk = true;
                const baseUrl = entry.baseUrl;
                if (typeof baseUrl !== "string" || !baseUrl.startsWith("https://")) {
                    errors.push(
                        `inference.customProviders.${id}.baseUrl: must be an https URL (got ${describe(baseUrl)}).`,
                    );
                    entryOk = false;
                }
                const apiKey = entry.apiKey;
                if (typeof apiKey !== "string" || apiKey.length === 0) {
                    errors.push(
                        `inference.customProviders.${id}.apiKey: must be a non-empty string.`,
                    );
                    entryOk = false;
                }
                const type = entry.type;
                if (type !== "openai-compatible") {
                    errors.push(
                        `inference.customProviders.${id}.type: only "openai-compatible" is supported (got ${describe(type)}).`,
                    );
                    entryOk = false;
                }
                if (entryOk) {
                    customIds.add(id);
                }
            }
        }
    }

    if (
        defaultProvider !== undefined &&
        !apiKeyIds.has(defaultProvider) &&
        !customIds.has(defaultProvider)
    ) {
        errors.push(
            `inference.defaultProvider "${defaultProvider}" must match an inference.apiKeys.* entry (with a key set) or an inference.customProviders.* entry.`,
        );
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Lint and either log warnings + return cleanly, or throw with a
 * concatenated error message. Used at daemon boot so a malformed
 * `config.yml` fails fast with one actionable diagnostic instead of a
 * cascade of cryptic per-call failures further down the startup path.
 */
export function lintOrThrow(path: string, log: Logger): void {
    const result = lintConfigFile(path);
    for (const w of result.warnings) {
        log.warn(w);
    }
    if (!result.ok) {
        throw new Error(
            `config.yml has ${result.errors.length} error(s):\n  - ${result.errors.join("\n  - ")}`,
        );
    }
}

/**
 * Verify a dotted-path key resolves to a non-empty string. Pushes a
 * descriptive error and returns `undefined` when the key is missing
 * or the wrong shape; otherwise returns the value so the caller can
 * use it for derived checks (e.g. looking up
 * `inference.apiKeys.<provider>`).
 */
function requireString(
    root: Record<string, unknown>,
    path: string,
    errors: string[],
): string | undefined {
    const value = readPath(root, path);
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    if (value === undefined) {
        errors.push(`Missing required key ${path}.`);
    } else {
        errors.push(`${path} must be a non-empty string (got ${describe(value)}).`);
    }
    return undefined;
}

/**
 * Verify an optional dotted-path key, when present, is a positive
 * integer. Records a warning if the value is present but malformed —
 * accessors fall back to their default at read time, so this is not
 * a hard error.
 */
function optionalPositiveInt(
    root: Record<string, unknown>,
    path: string,
    warnings: string[],
): void {
    const value = readPath(root, path);
    if (value === undefined) {
        return;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        warnings.push(`${path} should be a positive integer (got ${describe(value)}).`);
    }
}

/**
 * Validate that an optional path, when present, is a boolean.
 * Records a warning if malformed; accessors fall back to their
 * default at read time, so this is not a hard error.
 */
function optionalBool(root: Record<string, unknown>, path: string, warnings: string[]): void {
    const value = readPath(root, path);
    if (value === undefined) {
        return;
    }
    if (typeof value !== "boolean") {
        warnings.push(`${path} should be a boolean (got ${describe(value)}).`);
    }
}

/**
 * Validate that an optional path, when present, is a non-empty
 * string. Records a warning if malformed; accessors fall back to
 * their default at read time, so this is not a hard error.
 */
function optionalString(root: Record<string, unknown>, path: string, warnings: string[]): void {
    const value = readPath(root, path);
    if (value === undefined) {
        return;
    }
    if (typeof value !== "string" || value.length === 0) {
        warnings.push(`${path} should be a non-empty string (got ${describe(value)}).`);
    }
}

/**
 * Validate that an optional path, when present, is a string accepted
 * by `Intl.DateTimeFormat` as an IANA timezone. Catches typos
 * (`Europe/Berln`, `UTC+1`) at lint time so the daemon starts with a
 * predictable timezone for calendar tooling.
 */
function optionalIanaTimezone(
    root: Record<string, unknown>,
    path: string,
    warnings: string[],
): void {
    const value = readPath(root, path);
    if (value === undefined) {
        return;
    }
    if (typeof value !== "string" || value.length === 0) {
        warnings.push(
            `${path} should be a non-empty IANA timezone string (got ${describe(value)}).`,
        );
        return;
    }
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
    } catch {
        warnings.push(
            `${path}: "${value}" is not a recognised IANA timezone (e.g. "Europe/Berlin").`,
        );
    }
}

/**
 * Like {@link optionalPositiveInt} but allows `0` (e.g. for
 * `inference.maxRetries: 0` to disable retries entirely).
 */
function optionalNonNegativeInt(
    root: Record<string, unknown>,
    path: string,
    warnings: string[],
): void {
    const value = readPath(root, path);
    if (value === undefined) {
        return;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        warnings.push(`${path} should be a non-negative integer (got ${describe(value)}).`);
    }
}

/**
 * Walk a dotted path; returns `undefined` for any missing or
 * non-object intermediate. Mirror of the helper in
 * {@link ./ConfigService}; duplicated here so the linter doesn't
 * depend on the runtime service.
 */
function readPath(root: Record<string, unknown>, path: string): unknown {
    let cursor: unknown = root;
    for (const seg of path.split(".")) {
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
