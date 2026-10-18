import type { McpSource } from "../McpEntry.js";
import type { PublisherIdentity } from "./PublisherIdentity.js";

/**
 * Where an MCP's code comes from, strongest first:
 *
 * - `docker-built` — Docker MCP catalog entry whose image Docker builds
 *   itself (`mcp/<name>` on Docker Hub), signed and with provenance.
 * - `docker-community-image` — Docker MCP catalog entry whose image the
 *   publisher builds and pushes (`ghcr.io/…`, `vendor/…`).
 * - `docker-remote` — Docker MCP catalog entry pointing at a hosted
 *   endpoint; the code runs on the operator's servers.
 * - `registry-only` — only in the official MCP registry, which verifies
 *   the publisher's namespace but not the code.
 */
export type ProvenanceTier =
    | "docker-built"
    | "docker-community-image"
    | "docker-remote"
    | "registry-only";

/** How the candidate would land in `config/mcp.yml`. */
export interface InstallPlan {
    readonly source: McpSource;
    /** Image (docker-mcp-registry), package (npm/pypi) or URL (external). */
    readonly identifier: string;
    readonly version?: string;
    /** What the user has to provide, e.g. "`BRAVE_API_KEY` (secret)". */
    readonly requirements: readonly string[];
}

/** Popularity numbers found for a candidate; each is absent when unknown. */
export interface PopularitySignals {
    readonly githubStars?: number;
    readonly dockerPulls?: number;
    /** npm or PyPI downloads in the last month. */
    readonly monthlyDownloads?: number;
    /** Lookups that failed (rate limit, network), for the findings list. */
    readonly notes: readonly string[];
}

/** One search hit that fits our runtime, before rating. */
export interface McpSearchCandidate {
    readonly registry: "docker" | "official";
    /** Docker catalog key (`brave`) or official reverse-DNS name (`com.notion/mcp`). */
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly tier: ProvenanceTier;
    readonly install: InstallPlan;
    /** Further installable variants of the same server not shown in the plan. */
    readonly alternativeInstalls: number;
    /** Registry-verified publisher (official registry only). */
    readonly publisher: PublisherIdentity | null;
    /** `metadata.owner` of a Docker catalog entry. */
    readonly owner?: string;
    /** Full image reference (digest pin included) for platform/pull lookups. */
    readonly imageReference?: string;
    /** Image repository without the name, e.g. `ghcr.io/github` (image installs only). */
    readonly imageNamespace?: string;
    readonly repository?: { readonly owner: string; readonly repo: string; readonly url: string };
    /** Endpoint of a remote install. */
    readonly remoteUrl?: string;
    /** `os/arch` list of the image, when it was looked up. */
    readonly platforms?: readonly string[];
    /** Why the platform could not be checked, when it couldn't. */
    readonly platformNote?: string;
    readonly popularity: PopularitySignals;
}

/** One reason that moved (or explains) a rating. */
export interface RatingFinding {
    /** Star delta this finding contributed; `0` for context-only findings. */
    readonly effect: number;
    readonly text: string;
}

/** The security rating of one candidate. */
export interface SecurityRating {
    /** 0…5. */
    readonly stars: number;
    /** `yes` when the publisher is the vendor of the targeted service, `likely` on a partial name match. */
    readonly firstParty: "yes" | "likely" | "no";
    /** Base finding first, then adjustments and context. */
    readonly findings: readonly RatingFinding[];
}

/** A candidate with its rating. */
export interface RatedCandidate extends McpSearchCandidate {
    readonly rating: SecurityRating;
}

/** A registry entry dropped before rating, with the reason. */
export interface ExcludedEntry {
    readonly registry: "docker" | "official";
    readonly name: string;
    readonly reason: string;
}

/** Everything one search produced. */
export interface McpSearchResult {
    readonly query: string;
    /** Platform the images were checked against, e.g. `linux/amd64`. */
    readonly platform: string;
    /** Sorted best first, at most the requested limit. */
    readonly candidates: readonly RatedCandidate[];
    /** Fitting candidates cut by the limit. */
    readonly omittedCount: number;
    readonly excluded: readonly ExcludedEntry[];
    /** Registry failures; the search still returns what the other registry found. */
    readonly warnings: readonly string[];
}

/** One setting a server wants: env var, catalog parameter, remote header or CLI argument. */
export interface EnvVarSpec {
    readonly name: string;
    readonly kind: "env" | "parameter" | "header" | "argument";
    readonly isSecret: boolean;
    readonly isRequired: boolean;
    readonly description?: string;
    readonly defaultValue?: string;
}

/**
 * Registry facts about one server for `mcp_registry_details`, taken from
 * the raw entry — available even when the server is not suitable.
 * All strings are already sanitized.
 */
export interface McpDetailsSubject {
    readonly registry: "docker" | "official";
    readonly name: string;
    readonly title: string;
    readonly description: string;
    /** Official: `server.version`; Docker: the pinned source commit. */
    readonly version?: string;
    /** Official registry lifecycle status. */
    readonly lifecycleStatus?: string;
    readonly repository?: { readonly owner: string; readonly repo: string; readonly url: string };
    /** Git ref the repository files are read at (`HEAD` when unknown). */
    readonly repositoryRef: string;
    /** Path of the server inside a monorepo. */
    readonly repositorySubfolder?: string;
    /** Settings per install identifier (image / package / remote URL). */
    readonly settingsByInstall: ReadonlyMap<string, readonly EnvVarSpec[]>;
    /** Docker catalog per-server tool list URL. */
    readonly toolsUrl?: string;
    /** Tool names inlined in the Docker catalog (fallback without `toolsUrl`). */
    readonly inlineToolNames: readonly string[];
    /** Docker catalog volume templates. */
    readonly volumes: readonly string[];
    /** Docker catalog egress allowlist (`host:port`). */
    readonly allowHosts: readonly string[];
    readonly remoteUrls: readonly string[];
}
