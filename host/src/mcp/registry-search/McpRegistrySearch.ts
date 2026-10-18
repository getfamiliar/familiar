import { searchDockerCatalog } from "./DockerCatalogSearch.js";
import { detectContainerPlatform, fetchImagePlatforms } from "./ImagePlatforms.js";
import { searchOfficialRegistry } from "./OfficialRegistrySearch.js";
import { withPopularity } from "./PopularityLookup.js";
import { mapWithConcurrency } from "./RegistryHttp.js";
import type {
    ExcludedEntry,
    McpSearchCandidate,
    McpSearchResult,
    ProvenanceTier,
    RatedCandidate,
} from "./SearchCandidate.js";
import { rateCandidate } from "./SecurityRating.js";

/** Rows shown when the caller sets no limit. */
export const DEFAULT_SEARCH_LIMIT = 20;

/** Parallel platform / popularity lookups. */
const LOOKUP_CONCURRENCY = 6;

/** Tie-break order after the star rating. */
const TIER_ORDER: readonly ProvenanceTier[] = [
    "docker-built",
    "docker-community-image",
    "docker-remote",
    "registry-only",
];

/** Options of {@link searchMcpRegistries}. */
export interface McpRegistrySearchOptions {
    /** Search term, e.g. `notion` or `google calendar`. */
    readonly query: string;
    /** Rows to return at most; default {@link DEFAULT_SEARCH_LIMIT}. */
    readonly limit?: number;
    /** `os/arch` to check images against; default: the docker engine's platform. */
    readonly platform?: string;
}

/**
 * Search the Docker MCP catalog and the official MCP registry for MCP
 * servers matching a term, drop the ones our runtime can't use
 * (unsupported package types, auth-gated remotes, retired servers,
 * images without a variant for our platform, official entries already
 * in the Docker catalog), and rate the rest with 0–5 security stars.
 *
 * A failing registry becomes a warning; the other one's results still
 * come back.
 *
 * @param options Query, limit, platform.
 * @returns Rated candidates best first, exclusions and warnings.
 * @throws Error when the query is empty.
 */
export async function searchMcpRegistries(
    options: McpRegistrySearchOptions,
): Promise<McpSearchResult> {
    const query = options.query.trim();
    if (query.length === 0) {
        throw new Error("search term must not be empty");
    }
    const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_SEARCH_LIMIT));
    const platform = options.platform ?? (await detectContainerPlatform());
    const warnings: string[] = [];
    const excluded: ExcludedEntry[] = [];

    const [dockerResult, officialResult] = await Promise.allSettled([
        searchDockerCatalog(query),
        searchOfficialRegistry(query),
    ]);

    const fitting: McpSearchCandidate[] = [];
    if (dockerResult.status === "fulfilled") {
        excluded.push(...dockerResult.value.excluded);
        const checked = await mapWithConcurrency(
            dockerResult.value.candidates,
            LOOKUP_CONCURRENCY,
            (candidate) => checkPlatform(candidate, platform),
        );
        for (const outcome of checked) {
            if ("reason" in outcome) {
                excluded.push(outcome);
            } else {
                fitting.push(outcome);
            }
        }
    } else {
        warnings.push(`Docker MCP catalog search failed: ${errorText(dockerResult.reason)}`);
    }

    if (officialResult.status === "fulfilled") {
        excluded.push(...officialResult.value.excluded);
        warnings.push(...officialResult.value.warnings);
        if (officialResult.value.isTruncated) {
            warnings.push(
                "The official registry has more name matches than were scanned; servers whose name starts with the term were searched separately — use a more specific term to be thorough.",
            );
        }
        const dockerByRepository = new Map<string, string>();
        for (const candidate of fitting) {
            if (candidate.repository !== undefined) {
                dockerByRepository.set(repositoryKey(candidate.repository), candidate.name);
            }
        }
        const resolved = await mapWithConcurrency(
            officialResult.value.matches,
            LOOKUP_CONCURRENCY,
            async (match): Promise<McpSearchCandidate | ExcludedEntry> => {
                const first = match.variants[0] as McpSearchCandidate;
                const twin =
                    first.repository !== undefined
                        ? dockerByRepository.get(repositoryKey(first.repository))
                        : undefined;
                if (twin !== undefined) {
                    return {
                        registry: "official",
                        name: first.name,
                        reason: `same source repository as Docker MCP catalog entry \`${twin}\` (stronger provenance, listed there)`,
                    };
                }
                return firstFittingVariant(match.variants, platform);
            },
        );
        for (const outcome of resolved) {
            if ("reason" in outcome) {
                excluded.push(outcome);
            } else {
                fitting.push(outcome);
            }
        }
    } else {
        warnings.push(`Official MCP registry search failed: ${errorText(officialResult.reason)}`);
    }

    // Popularity lookups cost requests (GitHub allows 60/h anonymously),
    // so only the head of the preliminary ranking gets them.
    const preliminary = sortRated(fitting.map((candidate) => rate(candidate, query)));
    const head = preliminary.slice(0, limit + 10);
    const enriched = await mapWithConcurrency(head, LOOKUP_CONCURRENCY, (candidate) =>
        withPopularity(candidate),
    );
    const final = sortRated(enriched.map((candidate) => rate(candidate, query)));
    return {
        query,
        platform,
        candidates: final.slice(0, limit),
        omittedCount: fitting.length - Math.min(limit, final.length),
        excluded,
        warnings,
    };
}

/**
 * The first install variant that runs on `platform`, or an exclusion
 * listing why none does.
 *
 * @param variants Variants best first.
 * @param platform Target platform.
 * @returns The variant or the exclusion.
 */
export async function firstFittingVariant(
    variants: readonly McpSearchCandidate[],
    platform: string,
): Promise<McpSearchCandidate | ExcludedEntry> {
    const reasons: string[] = [];
    for (const variant of variants) {
        const outcome = await checkPlatform(variant, platform);
        if (!("reason" in outcome)) {
            return outcome;
        }
        reasons.push(outcome.reason);
    }
    const first = variants[0] as McpSearchCandidate;
    return { registry: first.registry, name: first.name, reason: reasons.join("; ") };
}

/**
 * Check an image candidate against the platform. Non-image candidates
 * pass; a failed lookup keeps the candidate with a note.
 *
 * @param candidate The candidate.
 * @param platform Target `os/arch`.
 * @returns The candidate (with platforms) or an exclusion.
 */
export async function checkPlatform(
    candidate: McpSearchCandidate,
    platform: string,
): Promise<McpSearchCandidate | ExcludedEntry> {
    if (candidate.imageReference === undefined) {
        return candidate;
    }
    let platforms: string[];
    try {
        platforms = await fetchImagePlatforms(candidate.imageReference);
    } catch (err) {
        return { ...candidate, platformNote: `platform not verified: ${errorText(err)}` };
    }
    if (platforms.length === 0) {
        return { ...candidate, platformNote: "platform not verified: image lists no platform" };
    }
    if (!platforms.includes(platform)) {
        return {
            registry: candidate.registry,
            name: candidate.name,
            reason: `image \`${candidate.install.identifier}\` has no ${platform} variant (only ${platforms.join(", ")})`,
        };
    }
    return { ...candidate, platforms };
}

/**
 * Attach the rating.
 *
 * @param candidate The candidate.
 * @param query The search term.
 * @returns The rated candidate.
 */
function rate(candidate: McpSearchCandidate, query: string): RatedCandidate {
    return { ...candidate, rating: rateCandidate(candidate, query) };
}

/**
 * Sort best first: stars, tier, first party, GitHub stars, name.
 *
 * @param candidates Rated candidates.
 * @returns A sorted copy.
 */
function sortRated(candidates: readonly RatedCandidate[]): RatedCandidate[] {
    const firstPartyRank = { yes: 0, likely: 1, no: 2 } as const;
    return [...candidates].sort(
        (a, b) =>
            b.rating.stars - a.rating.stars ||
            TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) ||
            firstPartyRank[a.rating.firstParty] - firstPartyRank[b.rating.firstParty] ||
            (b.popularity.githubStars ?? 0) - (a.popularity.githubStars ?? 0) ||
            a.name.localeCompare(b.name),
    );
}

/**
 * Comparison key of a GitHub repository.
 *
 * @param repository Owner and repo.
 * @returns `owner/repo` lowercased.
 */
function repositoryKey(repository: { readonly owner: string; readonly repo: string }): string {
    return `${repository.owner}/${repository.repo}`.toLowerCase();
}

/**
 * Message of an unknown thrown value.
 *
 * @param err The thrown value.
 * @returns Its message.
 */
export function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
