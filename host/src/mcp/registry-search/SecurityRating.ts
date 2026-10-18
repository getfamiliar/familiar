import { hostMainLabel, serviceTokens } from "./PublisherIdentity.js";
import type {
    McpSearchCandidate,
    PopularitySignals,
    RatingFinding,
    SecurityRating,
} from "./SearchCandidate.js";

/** Highest rating a tier other than `docker-built` can reach. */
const NON_DOCKER_BUILT_CAP = 4;

/** Below these, a popularity number counts as low (the relevant direction of a weak signal). */
const LOW_GITHUB_STARS = 25;
const LOW_DOCKER_PULLS = 1000;
const LOW_MONTHLY_DOWNLOADS = 200;

/** At or above these, a popularity number counts as high. */
const HIGH_GITHUB_STARS = 1000;
const HIGH_DOCKER_PULLS = 100_000;
const HIGH_MONTHLY_DOWNLOADS = 50_000;

/**
 * Rate one candidate's trustworthiness with 0–5 stars and list the
 * findings that led there, so the agent can argue the rating.
 *
 * 1. The provenance tier sets the base: `docker-built` is a fixed 5/5;
 *    `docker-community-image` and `docker-remote` start at 3;
 *    `registry-only` starts at 1 and always needs further investigation.
 * 2. Publisher identity: a publisher that is the vendor of the targeted
 *    service ("first party") adds +2 for registry-only entries (+1 for a
 *    likely match) and +1 for Docker community/remote entries; a
 *    community image pushed under the upstream repository owner's
 *    namespace adds +1.
 * 3. Popularity (stars, pulls, downloads) is weak: all-low −1, high +1.
 *
 * Non-`docker-built` ratings are clamped to 0…4.
 *
 * @param candidate The candidate (with popularity filled in).
 * @param query The user's search term — names the service the user is after.
 * @returns The rating.
 */
export function rateCandidate(candidate: McpSearchCandidate, query: string): SecurityRating {
    const findings: RatingFinding[] = [];
    const firstParty = assessFirstParty(candidate, query);

    if (candidate.tier === "docker-built") {
        findings.push({
            effect: 5,
            text: `Docker-built image \`${candidate.install.identifier}\`: Docker builds it from the reviewed source and signs it, with provenance attestation and SBOM — strongest tier, fixed 5/5.`,
        });
        findings.push(...firstParty.findings.map((f) => ({ ...f, effect: 0 })));
        findings.push(...popularityFindings(candidate.popularity, false).findings);
        return { stars: 5, firstParty: firstParty.level, findings };
    }

    let stars: number;
    if (candidate.tier === "docker-community-image") {
        stars = 3;
        findings.push({
            effect: 3,
            text: `Docker MCP catalog entry (reviewed when listed), but the image \`${candidate.install.identifier}\` is built and pushed by its publisher, not by Docker — no Docker signature or provenance. Base 3/5.`,
        });
        const namespaceOwner = imageNamespaceOwner(candidate.imageNamespace);
        if (
            namespaceOwner !== null &&
            candidate.repository !== undefined &&
            namespaceOwner === candidate.repository.owner
        ) {
            stars += 1;
            findings.push({
                effect: 1,
                text: `Image is pushed under \`${candidate.imageNamespace}\`, the namespace of the upstream repository owner \`${candidate.repository.owner}\`.`,
            });
        } else if (namespaceOwner !== null && candidate.repository !== undefined) {
            findings.push({
                effect: 0,
                text: `Image namespace \`${candidate.imageNamespace}\` differs from the upstream repository owner \`${candidate.repository.owner}\` — a repackaged build.`,
            });
        }
    } else if (candidate.tier === "docker-remote") {
        stars = 3;
        findings.push({
            effect: 3,
            text: `Remote endpoint curated in the Docker MCP catalog; the code runs on the operator's servers and cannot be inspected. Base 3/5.`,
        });
    } else {
        stars = 1;
        findings.push({
            effect: 1,
            text: "Only listed in the official MCP registry: it verifies the publisher's namespace, not the code. Base 1/5 — needs further investigation (read the source repository before installing).",
        });
    }

    for (const finding of firstParty.findings) {
        stars += finding.effect;
        findings.push(finding);
    }
    const popularity = popularityFindings(candidate.popularity, true);
    stars += popularity.delta;
    findings.push(...popularity.findings);

    if (stars > NON_DOCKER_BUILT_CAP) {
        findings.push({
            effect: NON_DOCKER_BUILT_CAP - stars,
            text: `Capped at ${NON_DOCKER_BUILT_CAP}/5: only Docker-built images reach 5/5.`,
        });
    }
    return {
        stars: Math.max(0, Math.min(NON_DOCKER_BUILT_CAP, stars)),
        firstParty: firstParty.level,
        findings,
    };
}

/**
 * Decide whether the publisher is the vendor of the service the MCP
 * targets. The service target is the search term when it names the
 * entry (searching `notion` finds Notion MCPs) or the entry names no
 * service at all, else the entry's own name/title tokens. Publisher keys are the registry-verified namespace
 * (official registry), the catalog owner, the image namespace owner or
 * the remote endpoint's domain (Docker catalog).
 *
 * @param candidate The candidate.
 * @param query The search term.
 * @returns The level and its findings (effects already tier-specific).
 */
function assessFirstParty(
    candidate: McpSearchCandidate,
    query: string,
): { level: "yes" | "likely" | "no"; findings: RatingFinding[] } {
    const findings: RatingFinding[] = [];
    const nameTail = candidate.name.split("/").pop() ?? candidate.name;
    const entryTokens = serviceTokens(nameTail, candidate.title);
    const queryTokens = serviceTokens(query);
    // An entry whose name carries no service (`com.notion/mcp`) is about
    // whatever the user searched for.
    const queryNamesEntry =
        entryTokens.size === 0 || [...queryTokens].some((token) => entryTokens.has(token));
    const target = queryNamesEntry ? queryTokens : entryTokens;
    const targetLabel = [...target].join(" ") || "(unknown)";
    const isRegistryOnly = candidate.tier === "registry-only";
    const remoteLabel =
        candidate.remoteUrl !== undefined ? hostMainLabel(candidate.remoteUrl) : null;

    const publisherKeys = new Map<string, string>();
    if (candidate.publisher !== null) {
        publisherKeys.set(candidate.publisher.key, `publisher ${candidate.publisher.display}`);
        findings.push({
            effect: 0,
            text:
                candidate.publisher.kind === "github"
                    ? `Publisher verified by the registry via GitHub login: ${candidate.publisher.display}.`
                    : `Publisher verified by the registry via DNS ownership: ${candidate.publisher.display}.`,
        });
        if (
            candidate.publisher.kind === "github" &&
            candidate.repository !== undefined &&
            candidate.repository.owner !== candidate.publisher.key
        ) {
            findings.push({
                effect: 0,
                text: `Source repository belongs to \`${candidate.repository.owner}\`, not to the publisher \`${candidate.publisher.key}\`.`,
            });
        }
        if (remoteLabel !== null && remoteLabel === candidate.publisher.key) {
            findings.push({
                effect: 0,
                text: "Remote endpoint is on the publisher's own domain.",
            });
        }
    }
    if (candidate.owner !== undefined && candidate.owner.toLowerCase() !== "docker") {
        publisherKeys.set(candidate.owner.toLowerCase(), `catalog owner \`${candidate.owner}\``);
    }
    const namespaceOwner = imageNamespaceOwner(candidate.imageNamespace);
    if (namespaceOwner !== null && candidate.tier !== "docker-built") {
        publisherKeys.set(namespaceOwner, `image namespace \`${candidate.imageNamespace}\``);
    }
    if (remoteLabel !== null && candidate.tier === "docker-remote") {
        publisherKeys.set(remoteLabel, `endpoint domain of ${candidate.remoteUrl}`);
    }

    for (const [key, source] of publisherKeys) {
        if (target.has(key)) {
            findings.push({
                effect: isRegistryOnly ? 2 : 1,
                text: `First party: ${source} is the vendor of the targeted service "${targetLabel}".`,
            });
            return { level: "yes", findings };
        }
    }
    for (const [key, source] of publisherKeys) {
        const partial = [...target].find(
            (token) => token.length >= 4 && key.includes(token) && key !== token,
        );
        if (partial !== undefined) {
            findings.push({
                effect: isRegistryOnly ? 1 : 0,
                text: `Likely first party: ${source} contains "${partial}" — verify it is the vendor's account.`,
            });
            return { level: "likely", findings };
        }
    }
    if (publisherKeys.size > 0 && target.size > 0) {
        findings.push({
            effect: 0,
            text: `Third party: no publisher signal matches the targeted service "${targetLabel}".`,
        });
    }
    return { level: "no", findings };
}

/**
 * Turn popularity numbers into findings. The signal is weak, so it only
 * moves the rating when all known numbers agree: all low −1, a high one
 * with no low one +1.
 *
 * @param popularity The numbers.
 * @param isScored Whether the findings move the rating (not for `docker-built`).
 * @returns The rating delta and the findings.
 */
function popularityFindings(
    popularity: PopularitySignals,
    isScored: boolean,
): { delta: number; findings: RatingFinding[] } {
    const parts: string[] = [];
    let lowCount = 0;
    let highCount = 0;
    let knownCount = 0;
    const tally = (value: number | undefined, label: string, low: number, high: number): void => {
        if (value === undefined) {
            return;
        }
        knownCount += 1;
        parts.push(`${formatCount(value)} ${label}`);
        if (value < low) {
            lowCount += 1;
        } else if (value >= high) {
            highCount += 1;
        }
    };
    tally(popularity.githubStars, "GitHub stars", LOW_GITHUB_STARS, HIGH_GITHUB_STARS);
    tally(popularity.dockerPulls, "Docker pulls", LOW_DOCKER_PULLS, HIGH_DOCKER_PULLS);
    tally(
        popularity.monthlyDownloads,
        "downloads last month",
        LOW_MONTHLY_DOWNLOADS,
        HIGH_MONTHLY_DOWNLOADS,
    );

    const findings: RatingFinding[] = [];
    let delta = 0;
    if (knownCount === 0) {
        findings.push({ effect: 0, text: "No popularity data available." });
    } else if (lowCount === knownCount) {
        delta = isScored ? -1 : 0;
        findings.push({ effect: delta, text: `Low adoption: ${parts.join(", ")}.` });
    } else if (highCount > 0 && lowCount === 0) {
        delta = isScored ? 1 : 0;
        findings.push({ effect: delta, text: `Widely used: ${parts.join(", ")}.` });
    } else {
        findings.push({ effect: 0, text: `Adoption: ${parts.join(", ")}.` });
    }
    for (const note of popularity.notes) {
        findings.push({ effect: 0, text: note });
    }
    return { delta, findings };
}

/**
 * Last path segment of an image namespace, lowercased (`ghcr.io/github` → `github`).
 *
 * @param namespace Image namespace, e.g. `ghcr.io/github` or `docker.io/hashicorp`.
 * @returns The owner token, or `null` when absent.
 */
function imageNamespaceOwner(namespace: string | undefined): string | null {
    if (namespace === undefined) {
        return null;
    }
    const last = namespace.split("/").pop();
    if (last === undefined || last.length === 0 || last.includes(".")) {
        return null;
    }
    return last.toLowerCase();
}

/**
 * Compact count: `1234` → `1.2k`, `1500000` → `1.5M`.
 *
 * @param value A non-negative count.
 * @returns The formatted count.
 */
export function formatCount(value: number): string {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    }
    if (value >= 1000) {
        return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    }
    return String(value);
}

/**
 * Render a star count as `★★★★☆ 4/5`.
 *
 * @param stars 0…5.
 * @returns The star string.
 */
export function renderStars(stars: number): string {
    return `${"★".repeat(stars)}${"☆".repeat(5 - stars)} ${stars}/5`;
}
