import type { EnvSlot, RegistryCandidate, RegistryHit } from "./RegistryEntry.js";

/**
 * List endpoint for the official MCP registry. Documented at
 * https://registry.modelcontextprotocol.io/docs#/operations/list-servers-v0.1.
 * Public, no auth.
 */
const OFFICIAL_REGISTRY_LIST = "https://registry.modelcontextprotocol.io/v0.1/servers";

/** Registry types we know how to install. Others are surfaced but skipped. */
const SUPPORTED_REGISTRY_TYPES: ReadonlySet<string> = new Set(["oci", "npm", "pypi"]);

/**
 * Search the official MCP registry for `name`. The endpoint accepts
 * a `search` query parameter that does substring matching across
 * server names, so we filter the response down to entries whose
 * `name` either equals `name` exactly or whose final reverse-DNS
 * segment equals `name` — that's the user-facing meaning of "this is
 * the package I want".
 *
 * Returns one {@link RegistryHit} per matching server. `candidates[]`
 * holds only npm/pypi/oci packages; other registry types
 * (`nuget`, `mcpb`, …) are dropped silently — the surface a user
 * sees in the dialogue is what we can install.
 *
 * Throws on network errors and non-2xx responses; an empty result is
 * an empty array, not a throw.
 */
export async function fetchOfficialRegistry(name: string): Promise<RegistryHit[]> {
    const url = `${OFFICIAL_REGISTRY_LIST}?search=${encodeURIComponent(name)}`;
    let response: Response;
    try {
        response = await fetch(url);
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`Official MCP registry network error for "${name}": ${cause}`);
    }
    if (!response.ok) {
        throw new Error(
            `Official MCP registry returned ${response.status} for "${name}" (${url}).`,
        );
    }
    let parsed: unknown;
    try {
        parsed = await response.json();
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`Official MCP registry JSON parse error for "${name}": ${cause}`);
    }
    if (!isMapping(parsed)) {
        throw new Error(`Official MCP registry: response root is not an object.`);
    }
    const servers = parsed.servers;
    if (!Array.isArray(servers)) {
        return [];
    }

    // Each `servers[]` entry is wrapped as `{ server: {...}, _meta: {...} }`
    // — the real fields live under `.server`. The registry also
    // returns one entry per published *version* of the same server,
    // so we group by name and keep only the entry the registry
    // marks as `isLatest`. Falling back to the last seen entry
    // when no flag is present keeps obscure registries usable too.
    const latestByName = new Map<string, Record<string, unknown>>();
    for (const wrapped of servers) {
        if (!isMapping(wrapped)) {
            continue;
        }
        const inner = isMapping(wrapped.server) ? wrapped.server : wrapped;
        if (!isMapping(inner)) {
            continue;
        }
        if (!serverNameMatches(inner.name, name)) {
            continue;
        }
        const serverName = inner.name as string;
        if (isLatestVersion(wrapped)) {
            latestByName.set(serverName, inner);
            continue;
        }
        // Don't clobber an entry already promoted by the
        // `isLatest` branch above.
        if (!latestByName.has(serverName)) {
            latestByName.set(serverName, inner);
        }
    }

    const hits: RegistryHit[] = [];
    for (const inner of latestByName.values()) {
        const hit = mapServer(inner);
        if (hit !== null && hit.candidates.length > 0) {
            hits.push(hit);
        }
    }
    return hits;
}

/**
 * Read the `_meta.io.modelcontextprotocol.registry/official.isLatest`
 * flag from a wrapped registry entry. The `_meta` key uses a literal
 * dotted-namespace string, so we index it as a single property.
 */
function isLatestVersion(wrapped: Record<string, unknown>): boolean {
    const meta = wrapped._meta;
    if (!isMapping(meta)) {
        return false;
    }
    const official = meta["io.modelcontextprotocol.registry/official"];
    if (!isMapping(official)) {
        return false;
    }
    return official.isLatest === true;
}

/**
 * Decide whether a registry server entry matches the user's
 * search term. We accept either an exact match on the full
 * reverse-DNS name (e.g. `io.github.foo/bar` exactly) or a match
 * on the final segment (`bar`) — that's what users mean when they
 * type a familiar short name.
 */
function serverNameMatches(serverName: unknown, query: string): boolean {
    if (typeof serverName !== "string") {
        return false;
    }
    if (serverName === query) {
        return true;
    }
    const tail = serverName.split("/").pop() ?? serverName;
    return tail === query;
}

/**
 * Translate one server entry from the registry response into our
 * intermediate. Returns `null` if there's no usable name (the
 * dialogue can't propose an id without one).
 */
function mapServer(server: Record<string, unknown>): RegistryHit | null {
    const registryName = server.name;
    if (typeof registryName !== "string" || registryName.length === 0) {
        return null;
    }
    const title =
        optionalString(server.title) ??
        // Fall back to the trailing segment for display.
        registryName.split("/").pop() ??
        registryName;
    const description = optionalString(server.description) ?? "";

    const candidates: RegistryCandidate[] = [];
    const packages = Array.isArray(server.packages) ? server.packages : [];
    for (const pkg of packages) {
        if (!isMapping(pkg)) {
            continue;
        }
        const candidate = mapPackage(pkg);
        if (candidate !== null) {
            candidates.push(candidate);
        }
    }

    return {
        registryName,
        title,
        description,
        candidates,
    };
}

/**
 * Translate one entry of the registry's `packages[]` array into a
 * {@link RegistryCandidate}. Skips registry types we don't support
 * (returns null) so the caller's filter is uniform.
 */
function mapPackage(pkg: Record<string, unknown>): RegistryCandidate | null {
    const registryType = pkg.registryType;
    if (typeof registryType !== "string" || !SUPPORTED_REGISTRY_TYPES.has(registryType)) {
        return null;
    }
    const identifier = pkg.identifier;
    if (typeof identifier !== "string" || identifier.length === 0) {
        return null;
    }
    const kind = registryType as "oci" | "npm" | "pypi";
    const version = optionalString(pkg.version);
    const envSlots = mapEnvironmentVariables(pkg.environmentVariables);
    const argSlots = mapPackageArguments(pkg.packageArguments);
    return {
        kind,
        identifier,
        version,
        preferred: kind === "oci",
        envSlots,
        argSlots,
    };
}

/**
 * Map a package's `environmentVariables[]` array into env slots.
 * Each slot's `description` is the registry's per-variable hint;
 * `defaultValue` comes from the registry's `default` if present.
 */
function mapEnvironmentVariables(value: unknown): EnvSlot[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const slots: EnvSlot[] = [];
    for (const item of value) {
        if (!isMapping(item)) {
            continue;
        }
        const name = typeof item.name === "string" ? item.name : undefined;
        if (name === undefined) {
            continue;
        }
        slots.push({
            name,
            description: optionalString(item.description),
            example: optionalString(item.example),
            isSecret: item.isSecret === true,
            defaultValue: optionalString(item.default) ?? optionalString(item.value),
        });
    }
    return slots;
}

/**
 * Map a package's `packageArguments[]` array into a flat string array
 * of pre-filled args. The official registry's argument schema is
 * richer than what `mcp.yml` supports (positional vs named, choices,
 * etc.), so we collapse it: each entry contributes its `value` (or
 * `default`) as a literal arg, and any structured parts the user
 * needs are surfaced through the dialogue's free-form arg loop.
 */
function mapPackageArguments(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const args: string[] = [];
    for (const item of value) {
        if (!isMapping(item)) {
            continue;
        }
        const literal = optionalString(item.value) ?? optionalString(item.default);
        if (literal !== undefined) {
            args.push(literal);
        }
    }
    return args;
}

/** Type guard for plain-mapping JSON nodes. */
function isMapping(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Coerce to a string only when present + non-empty; undefined otherwise. */
function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
