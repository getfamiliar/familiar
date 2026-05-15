import { existsSync, readFileSync } from "node:fs";
import { type Logger, RESERVED_GROUP_NAMES } from "effective-assistant-shared";
import { parse, YAMLParseError } from "yaml";
import {
    DEFAULT_IDLE_TIMEOUT_SECONDS,
    type McpEntries,
    type McpEntry,
    type McpEnvVar,
    type McpNetwork,
    type McpSource,
} from "./McpEntry.js";

/**
 * Result of an `mcp.yml` lint pass. Mirrors the shape of
 * `ConfigLintResult` for `config.yml`. `errors` are showstoppers (the
 * daemon refuses to start any MCP if any are present); `warnings` are
 * advisory and tolerated at runtime.
 */
export interface McpLintResult {
    readonly ok: boolean;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
}

/** Sources we accept in `mcp.yml`. Order shapes error messages only. */
const VALID_SOURCES: readonly McpSource[] = ["docker-mcp-registry", "npm", "pypi", "external"];

/**
 * Identifier rule for `mcp.yml` keys. Lowercase alphanumeric, leading
 * letter — same shape as the tools-DSL `IDENT_PATTERN`, because every
 * MCP id is auto-exposed as a same-named group in handler `tools:`
 * expressions. Hyphens and underscores are excluded so that ids
 * (a) compose unambiguously with `_` into `${id}_${toolName}` tool
 * keys, and (b) sit inside the alnum-only group-name shape the
 * evaluator uses to tell groups from tool patterns. Container names
 * still expand cleanly to `ea-mcp-<id>`.
 */
const ID_PATTERN = /^[a-z][a-z0-9]*$/;

/**
 * Validate `config/mcp.yml` against the per-entry minimum: every
 * entry has `title`, `description`, `source`, and the source-specific
 * fields its factory will need. A *missing* file is **not** an error —
 * `mcp.yml` is optional, the daemon simply runs no MCPs.
 *
 * Pure function: never throws, never logs. Callers decide what to do
 * with the result. See {@link loadMcpEntries} for the load-or-throw
 * helper used by the daemon.
 */
export function lintMcpConfigFile(path: string): McpLintResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!existsSync(path)) {
        // mcp.yml is optional — no entries means no MCPs.
        return { ok: true, errors, warnings };
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
        // Empty file is treated like a missing file: no entries.
        return { ok: true, errors, warnings };
    }
    if (typeof root !== "object" || Array.isArray(root)) {
        errors.push(`mcp.yml root in ${path} must be a YAML mapping.`);
        return { ok: false, errors, warnings };
    }

    for (const [id, value] of Object.entries(root as Record<string, unknown>)) {
        validateEntry(id, value, errors, warnings);
    }

    return { ok: errors.length === 0, errors, warnings };
}

/**
 * Lint and parse `config/mcp.yml` into typed `McpEntries`. Throws
 * with a concatenated diagnostic if linting fails. Returns an empty
 * map when the file is absent or holds no entries.
 *
 * The daemon calls this at boot before any MCP container is started
 * so a malformed file fails fast with one actionable message instead
 * of a cascade of per-entry errors at runtime.
 */
export function loadMcpEntries(path: string, log: Logger): McpEntries {
    const result = lintMcpConfigFile(path);
    for (const w of result.warnings) {
        log.warn(w);
    }
    if (!result.ok) {
        throw new Error(
            `mcp.yml has ${result.errors.length} error(s):\n  - ${result.errors.join("\n  - ")}`,
        );
    }
    if (!existsSync(path)) {
        return new Map();
    }
    const raw = readFileSync(path, "utf-8");
    const root = parse(raw);
    if (root === null || root === undefined) {
        return new Map();
    }
    const entries = new Map<string, McpEntry>();
    for (const [id, value] of Object.entries(root as Record<string, unknown>)) {
        // Lint already proved every entry valid — this just shapes it.
        entries.set(id, materializeEntry(id, value as Record<string, unknown>));
    }
    return entries;
}

/**
 * Per-entry validator. Pushes errors/warnings into the supplied
 * collectors; never throws. Source-specific required fields are
 * checked here so that factories can rely on them being present.
 */
function validateEntry(id: string, value: unknown, errors: string[], warnings: string[]): void {
    if (!ID_PATTERN.test(id)) {
        errors.push(
            `mcp.yml: id "${id}" must match ${ID_PATTERN} (lowercase alphanumeric, leading letter, no hyphens or underscores — every id doubles as a tools-DSL group name).`,
        );
        return;
    }
    // Each MCP id is exposed as an auto-group of the same name in
    // the tools-DSL (so handlers can write `tools: fetch + atlassian`
    // without a user toolgroup file). The four reserved names are
    // resolved by the evaluator before any group lookup, so an MCP
    // id that collides with one would be silently shadowed — reject
    // it loudly here instead.
    if (RESERVED_GROUP_NAMES.has(id)) {
        errors.push(
            `mcp.yml: id "${id}" is a reserved tools-DSL group name (${[...RESERVED_GROUP_NAMES].join(", ")}). Pick another id.`,
        );
        return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`mcp.yml entry "${id}" must be a mapping.`);
        return;
    }
    const e = value as Record<string, unknown>;

    requireString(e, id, "title", errors);
    requireString(e, id, "description", errors);

    const source = e.source;
    if (typeof source !== "string" || !VALID_SOURCES.includes(source as McpSource)) {
        errors.push(
            `mcp.yml entry "${id}": source must be one of ${VALID_SOURCES.join(", ")} (got ${describe(source)}).`,
        );
        return;
    }

    if (source === "docker-mcp-registry") {
        requireString(e, id, "image", errors);
    } else if (source === "npm" || source === "pypi") {
        requireString(e, id, "package", errors);
    } else if (source === "external") {
        requireString(e, id, "url", errors);
    }

    validateEnv(id, e.env, errors);
    validateStringArray(id, "volumes", e.volumes, errors);
    validateStringArray(id, "args", e.args, errors);
    validateNetwork(id, e.network, errors, warnings);

    if (e.command !== undefined && e.command !== null && typeof e.command !== "string") {
        errors.push(`mcp.yml entry "${id}": command must be a string or null.`);
    }

    if (e.idleTimeoutSeconds !== undefined) {
        if (
            typeof e.idleTimeoutSeconds !== "number" ||
            !Number.isInteger(e.idleTimeoutSeconds) ||
            e.idleTimeoutSeconds <= 0
        ) {
            errors.push(
                `mcp.yml entry "${id}": idleTimeoutSeconds must be a positive integer (got ${describe(e.idleTimeoutSeconds)}).`,
            );
        }
    }
}

/**
 * Assert a string field is present and non-empty on a YAML entry.
 * Pushes a descriptive error otherwise.
 */
function requireString(
    entry: Record<string, unknown>,
    id: string,
    key: string,
    errors: string[],
): void {
    const value = entry[key];
    if (typeof value === "string" && value.length > 0) {
        return;
    }
    if (value === undefined) {
        errors.push(`mcp.yml entry "${id}": missing required field "${key}".`);
    } else {
        errors.push(
            `mcp.yml entry "${id}": "${key}" must be a non-empty string (got ${describe(value)}).`,
        );
    }
}

/**
 * Validate an entry's `env[]` array. Each element must be a mapping
 * with at least `name` and `value`; optional fields are typechecked
 * but their absence is fine.
 */
function validateEnv(id: string, value: unknown, errors: string[]): void {
    if (value === undefined) {
        return;
    }
    if (!Array.isArray(value)) {
        errors.push(`mcp.yml entry "${id}": env must be an array.`);
        return;
    }
    for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            errors.push(`mcp.yml entry "${id}": env[${i}] must be a mapping.`);
            continue;
        }
        const env = item as Record<string, unknown>;
        if (typeof env.name !== "string" || env.name.length === 0) {
            errors.push(`mcp.yml entry "${id}": env[${i}].name must be a non-empty string.`);
        }
        if (typeof env.value !== "string") {
            errors.push(`mcp.yml entry "${id}": env[${i}].value must be a string.`);
        }
        if (env.is_secret !== undefined && typeof env.is_secret !== "boolean") {
            errors.push(`mcp.yml entry "${id}": env[${i}].is_secret must be a boolean.`);
        }
        if (env.example !== undefined && typeof env.example !== "string") {
            errors.push(`mcp.yml entry "${id}": env[${i}].example must be a string.`);
        }
        if (env.description !== undefined && typeof env.description !== "string") {
            errors.push(`mcp.yml entry "${id}": env[${i}].description must be a string.`);
        }
    }
}

/** Validate that an optional field is an array of strings. */
function validateStringArray(id: string, key: string, value: unknown, errors: string[]): void {
    if (value === undefined) {
        return;
    }
    if (!Array.isArray(value)) {
        errors.push(`mcp.yml entry "${id}": ${key} must be an array of strings.`);
        return;
    }
    for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== "string") {
            errors.push(`mcp.yml entry "${id}": ${key}[${i}] must be a string.`);
        }
    }
}

/** Validate the optional `network` block. */
function validateNetwork(id: string, value: unknown, errors: string[], _warnings: string[]): void {
    if (value === undefined) {
        return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`mcp.yml entry "${id}": network must be a mapping.`);
        return;
    }
    const net = value as Record<string, unknown>;
    if (net.disable !== undefined && typeof net.disable !== "boolean") {
        errors.push(`mcp.yml entry "${id}": network.disable must be a boolean.`);
    }
}

/**
 * Build a typed {@link McpEntry} from an already-validated YAML node.
 * Callers must have run {@link lintMcpConfigFile} first; this function
 * trusts the shape and only fills defaults.
 */
function materializeEntry(id: string, raw: Record<string, unknown>): McpEntry {
    const env = ((raw.env as McpEnvVar[] | undefined) ?? []).map((e) => ({
        name: e.name,
        value: e.value,
        is_secret: e.is_secret,
        example: e.example,
        description: e.description,
    }));
    const network: McpNetwork = {
        disable: Boolean((raw.network as Record<string, unknown> | undefined)?.disable ?? false),
    };
    return {
        id,
        title: raw.title as string,
        description: raw.description as string,
        source: raw.source as McpSource,
        env,
        volumes: (raw.volumes as string[] | undefined) ?? [],
        args: (raw.args as string[] | undefined) ?? [],
        command: typeof raw.command === "string" ? raw.command : null,
        network,
        image: typeof raw.image === "string" ? raw.image : undefined,
        package: typeof raw.package === "string" ? raw.package : undefined,
        version: typeof raw.version === "string" ? raw.version : undefined,
        url: typeof raw.url === "string" ? raw.url : undefined,
        idleTimeoutSeconds:
            typeof raw.idleTimeoutSeconds === "number"
                ? raw.idleTimeoutSeconds
                : DEFAULT_IDLE_TIMEOUT_SECONDS,
    };
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
