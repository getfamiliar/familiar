import { sanitizeExternalText } from "../../utils/ExternalTextSanitizer.js";
import { imageNamespace } from "./ImagePlatforms.js";
import { parseGithubRepo, parsePublisherIdentity, tokenize } from "./PublisherIdentity.js";
import { fetchJson, HttpStatusError, isMapping, optionalString } from "./RegistryHttp.js";
import type {
    EnvVarSpec,
    ExcludedEntry,
    InstallPlan,
    McpDetailsSubject,
    McpSearchCandidate,
} from "./SearchCandidate.js";

/** List endpoint of the official MCP registry (public, no auth). */
const OFFICIAL_REGISTRY_LIST = "https://registry.modelcontextprotocol.io/v0.1/servers";

/** Page size the registry allows at most. */
const PAGE_SIZE = 100;

/** Pages fetched at most — a broad term (`github`) matches hundreds of servers. */
const MAX_PAGES = 5;

/** Narrow searches make the registry scan its whole table (~30 s observed). */
const OFFICIAL_REGISTRY_TIMEOUT_MS = 60_000;

/** Lifecycle states that disqualify a server. */
const RETIRED_STATUSES: ReadonlySet<string> = new Set(["deprecated", "deleted"]);

/** Default package registries — the npm/pypi runtimes only fetch from these. */
const DEFAULT_REGISTRY_BASES: Readonly<Record<string, string>> = {
    npm: "https://registry.npmjs.org",
    pypi: "https://pypi.org",
};

/** One official-registry server that fits, as install variants best first. */
export interface OfficialServerMatch {
    /** Same server, one variant per installable package/remote; OCI first, then npm, pypi, remote. */
    readonly variants: readonly McpSearchCandidate[];
}

/** What an official-registry search produced. */
export interface OfficialRegistryMatches {
    readonly matches: OfficialServerMatch[];
    readonly excluded: ExcludedEntry[];
    /** Set when the plain search was cut at {@link MAX_PAGES}. */
    readonly isTruncated: boolean;
    /** Failed best-effort searches. */
    readonly warnings: readonly string[];
}

/**
 * Search the official MCP registry. The registry's `search` parameter
 * is a substring match on the full server name, so the longest query
 * token goes to the server and every token is checked locally against
 * name (minus the `io.github.` namespace prefix), title and description.
 * Only the latest version of each server is requested.
 *
 * A broad term (`github`) matches thousands of names via their
 * `io.github.*` namespace, and the alphabetical paging cuts off the
 * relevant ones. When the plain search is truncated, two targeted
 * searches follow: `/<term>` (name starts with the term) and `<term>/`
 * (namespace ends with it, e.g. `com.notion/…`). They are slow on the
 * registry side and best effort: a failure becomes a warning.
 *
 * @param query The search term.
 * @returns Fitting servers, exclusions, truncation flag and warnings.
 * @throws Error when the plain search fails.
 */
export async function searchOfficialRegistry(query: string): Promise<OfficialRegistryMatches> {
    const queryTokens = tokenize(query);
    const serverTerm = [...queryTokens].sort((a, b) => b.length - a.length)[0] ?? query;
    const primary = await fetchServerPages(serverTerm);
    const servers = [...primary.servers];
    const warnings: string[] = [];
    if (primary.isTruncated) {
        const targeted = await Promise.allSettled([
            fetchServerPages(`/${serverTerm}`),
            fetchServerPages(`${serverTerm}/`),
        ]);
        for (const outcome of targeted) {
            if (outcome.status === "fulfilled") {
                servers.push(...outcome.value.servers);
            } else {
                const cause =
                    outcome.reason instanceof Error
                        ? outcome.reason.message
                        : String(outcome.reason);
                warnings.push(`targeted official-registry search failed: ${cause}`);
            }
        }
    }
    const matches: OfficialServerMatch[] = [];
    const excluded: ExcludedEntry[] = [];
    const seen = new Set<string>();
    for (const wrapped of servers) {
        if (!isMapping(wrapped) || !isMapping(wrapped.server)) {
            continue;
        }
        const name = optionalString(wrapped.server.name);
        if (name === undefined || seen.has(name) || !isOfficialMatch(wrapped.server, queryTokens)) {
            continue;
        }
        seen.add(name);
        const mapped = mapOfficialServer(wrapped.server, lifecycleStatus(wrapped));
        if ("reason" in mapped) {
            excluded.push(mapped);
        } else {
            matches.push(mapped);
        }
    }
    return { matches, excluded, isTruncated: primary.isTruncated, warnings };
}

/**
 * Fetch up to {@link MAX_PAGES} pages of `servers[]` for one search term.
 *
 * @param serverTerm Value of the `search` parameter.
 * @returns The raw `servers[]` elements and whether more pages exist.
 * @throws Error on network or API failures.
 */
async function fetchServerPages(
    serverTerm: string,
): Promise<{ servers: unknown[]; isTruncated: boolean }> {
    const servers: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = new URL(OFFICIAL_REGISTRY_LIST);
        url.searchParams.set("search", serverTerm);
        url.searchParams.set("version", "latest");
        url.searchParams.set("limit", String(PAGE_SIZE));
        if (cursor !== undefined) {
            url.searchParams.set("cursor", cursor);
        }
        const body = await fetchJson(url.toString(), {}, OFFICIAL_REGISTRY_TIMEOUT_MS);
        if (!isMapping(body)) {
            throw new Error("official MCP registry: response root is not an object");
        }
        servers.push(...(Array.isArray(body.servers) ? body.servers : []));
        cursor = isMapping(body.metadata) ? optionalString(body.metadata.nextCursor) : undefined;
        if (cursor === undefined) {
            return { servers, isTruncated: false };
        }
    }
    return { servers, isTruncated: true };
}

/**
 * Whether every query token occurs in the server's name, title or
 * description. The `io.github.` namespace prefix doesn't count — it says
 * how the publisher logged in, not what the server is about.
 *
 * @param server The `server` object.
 * @param queryTokens Tokenized query.
 * @returns `true` on a match.
 */
function isOfficialMatch(server: Record<string, unknown>, queryTokens: readonly string[]): boolean {
    const name = typeof server.name === "string" ? server.name.replace(/^io\.github\./i, "") : "";
    const haystack = [name, server.title, server.description]
        .filter((part) => typeof part === "string")
        .join(" ")
        .toLowerCase();
    return queryTokens.every((token) => haystack.includes(token));
}

/**
 * Lifecycle status from `_meta["io.modelcontextprotocol.registry/official"].status`.
 *
 * @param wrapped A `servers[]` element.
 * @returns The status, `active` when absent.
 */
export function lifecycleStatus(wrapped: Record<string, unknown>): string {
    const meta = isMapping(wrapped._meta) ? wrapped._meta : {};
    const official = meta["io.modelcontextprotocol.registry/official"];
    return (isMapping(official) ? optionalString(official.status) : undefined) ?? "active";
}

/**
 * Map one server to its install variants, or to an exclusion.
 *
 * @param server The `server` object.
 * @param status Its lifecycle status.
 * @returns The match or the exclusion.
 */
export function mapOfficialServer(
    server: Record<string, unknown>,
    status: string,
): OfficialServerMatch | ExcludedEntry {
    const name = optionalString(server.name) ?? "(unnamed)";
    const exclude = (reason: string): ExcludedEntry => ({ registry: "official", name, reason });
    if (RETIRED_STATUSES.has(status)) {
        return exclude(`lifecycle status \`${status}\``);
    }
    const repositoryUrl = isMapping(server.repository)
        ? optionalString(server.repository.url)
        : undefined;
    const githubRepo = parseGithubRepo(repositoryUrl);
    const base = {
        registry: "official" as const,
        name,
        title: sanitizeExternalText(optionalString(server.title) ?? name.split("/").pop() ?? name),
        description: sanitizeExternalText(optionalString(server.description) ?? ""),
        tier: "registry-only" as const,
        publisher: parsePublisherIdentity(name),
        repository:
            githubRepo !== null && repositoryUrl !== undefined
                ? { ...githubRepo, url: repositoryUrl }
                : undefined,
        popularity: { notes: [] },
    };

    const rejections: string[] = [];
    const variants: Omit<McpSearchCandidate, "alternativeInstalls">[] = [];
    for (const pkg of Array.isArray(server.packages) ? server.packages : []) {
        if (!isMapping(pkg)) {
            continue;
        }
        const plan = mapPackage(pkg);
        if (typeof plan === "string") {
            rejections.push(plan);
            continue;
        }
        variants.push({
            ...base,
            install: plan,
            ...(plan.source === "docker-mcp-registry"
                ? {
                      imageReference: plan.identifier,
                      imageNamespace: imageNamespace(plan.identifier),
                  }
                : {}),
        });
    }
    for (const remote of Array.isArray(server.remotes) ? server.remotes : []) {
        if (!isMapping(remote)) {
            continue;
        }
        const plan = mapRemote(remote);
        if (typeof plan === "string") {
            rejections.push(plan);
            continue;
        }
        variants.push({ ...base, install: plan, remoteUrl: plan.identifier });
    }
    if (variants.length === 0) {
        return exclude(
            rejections.length > 0
                ? [...new Set(rejections)].join("; ")
                : "no packages or remotes published",
        );
    }
    const order = ["docker-mcp-registry", "npm", "pypi", "external"];
    variants.sort((a, b) => order.indexOf(a.install.source) - order.indexOf(b.install.source));
    return {
        variants: variants.map((variant) => ({
            ...variant,
            alternativeInstalls: variants.length - 1,
        })),
    };
}

/**
 * Map one `packages[]` element to an install plan.
 *
 * @param pkg The package object.
 * @returns The plan, or the reason it doesn't fit.
 */
function mapPackage(pkg: Record<string, unknown>): InstallPlan | string {
    const registryType = optionalString(pkg.registryType) ?? "unknown";
    const identifier = optionalString(pkg.identifier);
    if (registryType !== "oci" && registryType !== "npm" && registryType !== "pypi") {
        return `\`${registryType}\` package (only oci/npm/pypi run here)`;
    }
    if (identifier === undefined) {
        return `${registryType} package without identifier`;
    }
    const transport = isMapping(pkg.transport) ? optionalString(pkg.transport.type) : undefined;
    if (transport !== undefined && transport !== "stdio") {
        return `${registryType} package serves \`${transport}\` on a port (our container runtimes speak stdio)`;
    }
    const registryBase = optionalString(pkg.registryBaseUrl)?.replace(/\/+$/, "");
    const defaultBase = DEFAULT_REGISTRY_BASES[registryType];
    if (registryBase !== undefined && defaultBase !== undefined && registryBase !== defaultBase) {
        return `${registryType} package from a non-default registry ${registryBase}`;
    }
    const requirements: string[] = [];
    for (const env of Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : []) {
        if (!isMapping(env) || typeof env.name !== "string") {
            continue;
        }
        if (env.isSecret === true) {
            requirements.push(`\`${env.name}\` (secret)`);
        } else if (env.isRequired === true) {
            requirements.push(`\`${env.name}\``);
        }
    }
    for (const arg of Array.isArray(pkg.packageArguments) ? pkg.packageArguments : []) {
        if (isMapping(arg) && arg.isRequired === true && arg.value === undefined) {
            requirements.push(
                `argument \`${optionalString(arg.name) ?? optionalString(arg.valueHint) ?? "?"}\``,
            );
        }
    }
    if (registryType === "oci") {
        return { source: "docker-mcp-registry", identifier, requirements };
    }
    return { source: registryType, identifier, version: optionalString(pkg.version), requirements };
}

/**
 * Map one `remotes[]` element to an `external` install plan.
 *
 * @param remote The remote object.
 * @returns The plan, or the reason it doesn't fit.
 */
function mapRemote(remote: Record<string, unknown>): InstallPlan | string {
    const type = optionalString(remote.type) ?? "unknown";
    const url = optionalString(remote.url);
    if (url === undefined) {
        return "remote without URL";
    }
    if (type !== "streamable-http") {
        return `\`${type}\` remote (the agent connects via Streamable HTTP)`;
    }
    if (/\{[^}]+\}/.test(url)) {
        return "remote URL needs template variables filled in";
    }
    const headers = Array.isArray(remote.headers) ? remote.headers.filter(isMapping) : [];
    const neededHeaders = headers.filter(
        (header) =>
            header.isRequired === true ||
            header.isSecret === true ||
            /\{[^}]+\}/.test(optionalString(header.value) ?? ""),
    );
    if (neededHeaders.length > 0) {
        const names = neededHeaders.map((header) => optionalString(header.name) ?? "?").join(", ");
        return `remote needs request headers (${names}) — the \`external\` source can't send headers`;
    }
    return {
        source: "external",
        identifier: url,
        requirements: headers.length > 0 ? ["optional request headers (not supported)"] : [],
    };
}

/**
 * Fetch the latest version of one server by its exact name.
 *
 * @param name Reverse-DNS server name, e.g. `com.notion/mcp`.
 * @returns The `server` object and its lifecycle status, or `null` when unknown.
 * @throws Error on network or API failures.
 */
export async function fetchOfficialServer(
    name: string,
): Promise<{ server: Record<string, unknown>; status: string } | null> {
    const url = `${OFFICIAL_REGISTRY_LIST}/${encodeURIComponent(name)}/versions/latest`;
    let body: unknown;
    try {
        body = await fetchJson(url, {}, OFFICIAL_REGISTRY_TIMEOUT_MS);
    } catch (err) {
        if (err instanceof HttpStatusError && err.status === 404) {
            return null;
        }
        throw err;
    }
    if (!isMapping(body) || !isMapping(body.server)) {
        throw new Error(`official MCP registry: unexpected answer for "${name}"`);
    }
    return { server: body.server, status: lifecycleStatus(body) };
}

/**
 * Registry facts of an official server for the details report.
 *
 * @param server The `server` object.
 * @param status Its lifecycle status.
 * @returns The sanitized subject.
 */
export function describeOfficialServer(
    server: Record<string, unknown>,
    status: string,
): McpDetailsSubject {
    const name = optionalString(server.name) ?? "(unnamed)";
    const repository = isMapping(server.repository) ? server.repository : {};
    const repositoryUrl = optionalString(repository.url);
    const githubRepo = parseGithubRepo(repositoryUrl);
    const settingsByInstall = new Map<string, EnvVarSpec[]>();
    for (const pkg of Array.isArray(server.packages) ? server.packages : []) {
        const identifier = isMapping(pkg) ? optionalString(pkg.identifier) : undefined;
        if (identifier !== undefined && isMapping(pkg)) {
            settingsByInstall.set(identifier, packageSettings(pkg));
        }
    }
    const remoteUrls: string[] = [];
    for (const remote of Array.isArray(server.remotes) ? server.remotes : []) {
        const url = isMapping(remote) ? optionalString(remote.url) : undefined;
        if (url === undefined || !isMapping(remote)) {
            continue;
        }
        remoteUrls.push(url);
        const headers = Array.isArray(remote.headers) ? remote.headers.filter(isMapping) : [];
        settingsByInstall.set(
            url,
            headers
                .filter((header) => typeof header.name === "string")
                .map((header) => ({
                    name: header.name as string,
                    kind: "header" as const,
                    isSecret: header.isSecret === true,
                    isRequired: header.isRequired === true,
                    description: optionalSanitized(header.description),
                    defaultValue: optionalSanitized(header.value),
                })),
        );
    }
    return {
        registry: "official",
        name,
        title: sanitizeExternalText(optionalString(server.title) ?? name.split("/").pop() ?? name),
        description: sanitizeExternalText(optionalString(server.description) ?? ""),
        version: optionalString(server.version),
        lifecycleStatus: status,
        repository:
            githubRepo !== null && repositoryUrl !== undefined
                ? { ...githubRepo, url: repositoryUrl }
                : undefined,
        repositoryRef: "HEAD",
        repositorySubfolder: optionalString(repository.subfolder)?.replace(/^\/+|\/+$/g, ""),
        settingsByInstall,
        inlineToolNames: [],
        volumes: [],
        allowHosts: [],
        remoteUrls,
    };
}

/**
 * Settings of one package: all env vars (optional ones too) and
 * required arguments without a fixed value.
 *
 * @param pkg The package object.
 * @returns Sanitized setting specs.
 */
function packageSettings(pkg: Record<string, unknown>): EnvVarSpec[] {
    const settings: EnvVarSpec[] = [];
    for (const env of Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : []) {
        if (!isMapping(env) || typeof env.name !== "string") {
            continue;
        }
        settings.push({
            name: env.name,
            kind: "env",
            isSecret: env.isSecret === true,
            isRequired: env.isRequired === true,
            description: optionalSanitized(env.description),
            defaultValue: optionalSanitized(env.default) ?? optionalSanitized(env.value),
        });
    }
    for (const arg of Array.isArray(pkg.packageArguments) ? pkg.packageArguments : []) {
        if (!isMapping(arg)) {
            continue;
        }
        const label = optionalString(arg.name) ?? optionalString(arg.valueHint);
        if (label === undefined) {
            continue;
        }
        settings.push({
            name: label,
            kind: "argument",
            isSecret: arg.isSecret === true,
            isRequired: arg.isRequired === true,
            description: optionalSanitized(arg.description),
            defaultValue: optionalSanitized(arg.value) ?? optionalSanitized(arg.default),
        });
    }
    return settings;
}

/** A sanitized non-empty string, or undefined. */
function optionalSanitized(value: unknown): string | undefined {
    const text = optionalString(value);
    return text !== undefined ? sanitizeExternalText(text) || undefined : undefined;
}
