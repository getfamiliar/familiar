import { parse } from "yaml";
import { sanitizeExternalText } from "../../utils/ExternalTextSanitizer.js";
import { imageNamespace } from "./ImagePlatforms.js";
import { parseGithubRepo, parseGithubTreeUrl, tokenize } from "./PublisherIdentity.js";
import { fetchWithTimeout, isMapping, optionalNumber, optionalString } from "./RegistryHttp.js";
import type {
    EnvVarSpec,
    ExcludedEntry,
    McpDetailsSubject,
    McpSearchCandidate,
} from "./SearchCandidate.js";

/**
 * The Docker MCP catalog as Docker Desktop's MCP Toolkit reads it: every
 * server of https://github.com/docker/mcp-registry in one YAML file,
 * with pulls / stars / owner metadata. ~600 kB, public.
 */
const DOCKER_CATALOG_URL = "https://desktop.docker.com/mcp/catalog/v3/catalog.yaml";

/** The catalog is big and changes daily at most: keep it for an hour. */
const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;

/** The catalog download gets more time than the small lookups. */
const CATALOG_TIMEOUT_MS = 60_000;

let catalogCache: { readonly fetchedAt: number; readonly entries: Map<string, unknown> } | null =
    null;

/** What a Docker catalog search produced. */
export interface DockerCatalogMatches {
    readonly candidates: McpSearchCandidate[];
    readonly excluded: ExcludedEntry[];
}

/**
 * Search the Docker MCP catalog: an entry matches when every token of
 * `query` occurs in its key, title, description or tags. Matches that
 * our runtime can't run are returned as excluded with the reason.
 *
 * @param query The search term.
 * @returns Candidates (platform not yet checked) and exclusions.
 * @throws Error when the catalog can't be downloaded or parsed.
 */
export async function searchDockerCatalog(query: string): Promise<DockerCatalogMatches> {
    const entries = await loadCatalog();
    const queryTokens = tokenize(query);
    const candidates: McpSearchCandidate[] = [];
    const excluded: ExcludedEntry[] = [];
    for (const [key, raw] of entries) {
        if (!isMapping(raw) || !isCatalogMatch(key, raw, queryTokens)) {
            continue;
        }
        const mapped = mapCatalogEntry(key, raw);
        if ("reason" in mapped) {
            excluded.push(mapped);
        } else {
            candidates.push(mapped);
        }
    }
    return { candidates, excluded };
}

/**
 * Download (or reuse) the catalog's `registry` mapping.
 *
 * @returns Catalog key → entry.
 * @throws Error on download or parse failure.
 */
export async function loadCatalog(): Promise<Map<string, unknown>> {
    if (catalogCache !== null && Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
        return catalogCache.entries;
    }
    const response = await fetchWithTimeout(DOCKER_CATALOG_URL, {}, CATALOG_TIMEOUT_MS);
    if (!response.ok) {
        throw new Error(`Docker MCP catalog answered ${response.status} (${DOCKER_CATALOG_URL})`);
    }
    let root: unknown;
    try {
        root = parse(await response.text());
    } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`Docker MCP catalog YAML parse error: ${cause}`);
    }
    if (!isMapping(root) || !isMapping(root.registry)) {
        throw new Error("Docker MCP catalog has no `registry` mapping");
    }
    const entries = new Map(Object.entries(root.registry));
    catalogCache = { fetchedAt: Date.now(), entries };
    return entries;
}

/**
 * Whether every query token occurs in the entry's searchable text.
 *
 * @param key Catalog key.
 * @param entry Catalog entry.
 * @param queryTokens Tokenized query.
 * @returns `true` on a match.
 */
function isCatalogMatch(
    key: string,
    entry: Record<string, unknown>,
    queryTokens: readonly string[],
): boolean {
    const metadata = isMapping(entry.metadata) ? entry.metadata : {};
    const tags = Array.isArray(metadata.tags) ? metadata.tags.join(" ") : "";
    const haystack = [key, entry.title, entry.description, tags]
        .filter((part) => typeof part === "string")
        .join(" ")
        .toLowerCase();
    return queryTokens.every((token) => haystack.includes(token));
}

/**
 * Map one catalog entry to a candidate, or to an exclusion when our
 * runtime can't run it.
 *
 * @param key Catalog key.
 * @param entry Catalog entry.
 * @returns The candidate or the exclusion.
 */
export function mapCatalogEntry(
    key: string,
    entry: Record<string, unknown>,
): McpSearchCandidate | ExcludedEntry {
    const exclude = (reason: string): ExcludedEntry => ({ registry: "docker", name: key, reason });
    const metadata = isMapping(entry.metadata) ? entry.metadata : {};
    const upstream = optionalString(entry.upstream) ?? optionalString(entry.source);
    const githubRepo = parseGithubRepo(upstream);
    const base = {
        registry: "docker" as const,
        name: key,
        title: sanitizeExternalText(optionalString(entry.title) ?? key),
        description: sanitizeExternalText(optionalString(entry.description) ?? ""),
        alternativeInstalls: 0,
        publisher: null,
        owner: optionalString(metadata.owner),
        repository:
            githubRepo !== null && upstream !== undefined
                ? { ...githubRepo, url: upstream }
                : undefined,
        popularity: {
            githubStars: optionalNumber(metadata.githubStars),
            dockerPulls: optionalNumber(metadata.pulls),
            notes: [],
        },
    };

    const type = optionalString(entry.type);
    if (type === "remote") {
        const remote = isMapping(entry.remote) ? entry.remote : {};
        const url = optionalString(remote.url);
        if (url === undefined) {
            return exclude("remote entry without a URL");
        }
        if (isMapping(entry.oauth)) {
            return exclude(
                "remote endpoint needs an OAuth login — the `external` source only forwards to a URL",
            );
        }
        if (isMapping(remote.headers) && Object.keys(remote.headers).length > 0) {
            return exclude(
                `remote endpoint needs request headers (${Object.keys(remote.headers).join(", ")}) — the \`external\` source can't send headers`,
            );
        }
        const transport = optionalString(remote.transport_type) ?? "streamable-http";
        if (transport !== "streamable-http") {
            return exclude(
                `remote endpoint speaks \`${transport}\` only — the agent connects via Streamable HTTP`,
            );
        }
        return {
            ...base,
            tier: "docker-remote",
            install: { source: "external", identifier: url, requirements: [] },
            remoteUrl: url,
        };
    }
    if (type !== "server") {
        return exclude(
            type === "poci"
                ? "`poci` entry (a Docker Toolkit CLI wrapper), not an MCP server image"
                : `unsupported catalog entry type \`${type ?? "none"}\``,
        );
    }
    const image = optionalString(entry.image);
    if (image === undefined) {
        return exclude("server entry without an image");
    }
    const imageWithoutDigest = image.split("@")[0] as string;
    const namespace = imageNamespace(image);
    return {
        ...base,
        tier: namespace === "docker.io/mcp" ? "docker-built" : "docker-community-image",
        install: {
            source: "docker-mcp-registry",
            identifier: imageWithoutDigest,
            requirements: catalogRequirements(entry),
        },
        imageReference: image,
        imageNamespace: namespace,
    };
}

/**
 * What the user must provide for a catalog server: secrets, env vars,
 * config parameters, volume mounts.
 *
 * @param entry Catalog entry.
 * @returns Human-readable requirement strings.
 */
function catalogRequirements(entry: Record<string, unknown>): string[] {
    const requirements: string[] = [];
    for (const secret of Array.isArray(entry.secrets) ? entry.secrets : []) {
        const env = isMapping(secret) ? optionalString(secret.env) : undefined;
        if (env !== undefined) {
            requirements.push(`\`${env}\` (secret)`);
        }
    }
    for (const env of Array.isArray(entry.env) ? entry.env : []) {
        const name = isMapping(env) ? optionalString(env.name) : undefined;
        if (name !== undefined) {
            requirements.push(`\`${name}\``);
        }
    }
    for (const config of Array.isArray(entry.config) ? entry.config : []) {
        if (!isMapping(config) || !isMapping(config.properties)) {
            continue;
        }
        const prefix = optionalString(config.name);
        for (const property of Object.keys(config.properties)) {
            requirements.push(
                `parameter \`${prefix !== undefined ? `${prefix}.` : ""}${property}\``,
            );
        }
    }
    if (Array.isArray(entry.volumes) && entry.volumes.length > 0) {
        requirements.push("volume mounts");
    }
    return requirements;
}

/**
 * One catalog entry by key.
 *
 * @param key Catalog key, e.g. `notion`.
 * @returns The raw entry, or `null` when the catalog has no such key.
 * @throws Error when the catalog can't be loaded.
 */
export async function getDockerCatalogEntry(key: string): Promise<Record<string, unknown> | null> {
    const entry = (await loadCatalog()).get(key);
    return isMapping(entry) ? entry : null;
}

/**
 * Registry facts of a catalog entry for the details report.
 *
 * @param key Catalog key.
 * @param entry Raw catalog entry.
 * @returns The sanitized subject.
 */
export function describeCatalogEntry(
    key: string,
    entry: Record<string, unknown>,
): McpDetailsSubject {
    const source = optionalString(entry.source);
    const upstream = optionalString(entry.upstream) ?? source;
    const githubRepo = parseGithubRepo(upstream ?? source);
    const tree = parseGithubTreeUrl(source);
    const remote = isMapping(entry.remote) ? entry.remote : {};
    const remoteUrl = optionalString(remote.url);
    const image = optionalString(entry.image);
    const installKey = image !== undefined ? (image.split("@")[0] as string) : (remoteUrl ?? key);
    const settings: EnvVarSpec[] = catalogSettings(entry);
    if (isMapping(remote.headers)) {
        for (const header of Object.keys(remote.headers)) {
            settings.push({ name: header, kind: "header", isSecret: true, isRequired: true });
        }
    }
    const toolsUrl = optionalString(entry.toolsUrl)?.replace(/^http:\/\//, "https://");
    return {
        registry: "docker",
        name: key,
        title: sanitizeExternalText(optionalString(entry.title) ?? key),
        description: sanitizeExternalText(optionalString(entry.description) ?? ""),
        version: tree?.ref,
        repository:
            githubRepo !== null && upstream !== undefined
                ? { ...githubRepo, url: upstream }
                : undefined,
        repositoryRef: tree?.ref ?? "HEAD",
        repositorySubfolder: tree?.subfolder,
        settingsByInstall: new Map([[installKey, settings]]),
        toolsUrl,
        inlineToolNames: (Array.isArray(entry.tools) ? entry.tools : [])
            .map((tool) => (isMapping(tool) ? optionalString(tool.name) : undefined))
            .filter((name): name is string => name !== undefined)
            .map(sanitizeExternalText),
        volumes: stringList(entry.volumes),
        allowHosts: stringList(entry.allowHosts),
        remoteUrls: remoteUrl !== undefined ? [remoteUrl] : [],
    };
}

/**
 * Settings of a catalog server: secrets, env vars and config parameters.
 *
 * @param entry Raw catalog entry.
 * @returns Sanitized setting specs.
 */
function catalogSettings(entry: Record<string, unknown>): EnvVarSpec[] {
    const settings: EnvVarSpec[] = [];
    for (const secret of Array.isArray(entry.secrets) ? entry.secrets : []) {
        const name = isMapping(secret) ? optionalString(secret.env) : undefined;
        if (name === undefined || !isMapping(secret)) {
            continue;
        }
        settings.push({
            name,
            kind: "env",
            isSecret: true,
            isRequired: true,
            description: optionalSanitized(secret.description),
            defaultValue: optionalSanitized(secret.example),
        });
    }
    for (const env of Array.isArray(entry.env) ? entry.env : []) {
        const name = isMapping(env) ? optionalString(env.name) : undefined;
        if (name === undefined || !isMapping(env)) {
            continue;
        }
        settings.push({
            name,
            kind: "env",
            isSecret: false,
            isRequired: false,
            description: optionalSanitized(env.description),
            defaultValue: optionalSanitized(env.value),
        });
    }
    for (const config of Array.isArray(entry.config) ? entry.config : []) {
        if (!isMapping(config) || !isMapping(config.properties)) {
            continue;
        }
        const prefix = optionalString(config.name);
        const required = new Set(stringList(config.required));
        for (const [property, schema] of Object.entries(config.properties)) {
            settings.push({
                name: `${prefix !== undefined ? `${prefix}.` : ""}${property}`,
                kind: "parameter",
                isSecret: false,
                isRequired: required.has(property),
                description:
                    (isMapping(schema) ? optionalSanitized(schema.description) : undefined) ??
                    optionalSanitized(config.description),
                defaultValue: isMapping(schema) ? optionalSanitized(schema.default) : undefined,
            });
        }
    }
    return settings;
}

/** A sanitized non-empty string, or undefined. */
function optionalSanitized(value: unknown): string | undefined {
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    const text = optionalString(value);
    return text !== undefined ? sanitizeExternalText(text) || undefined : undefined;
}

/** The string elements of a YAML list. */
function stringList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string").map(sanitizeExternalText)
        : [];
}
