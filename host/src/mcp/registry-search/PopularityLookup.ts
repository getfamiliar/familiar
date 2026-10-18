import { fetchDockerHubPulls } from "./ImagePlatforms.js";
import { fetchJson, HttpStatusError, isMapping, optionalNumber } from "./RegistryHttp.js";
import type { McpSearchCandidate, PopularitySignals } from "./SearchCandidate.js";

/**
 * GitHub stars per `owner/repo`, kept for the process lifetime: the
 * unauthenticated GitHub API allows 60 requests per hour, so repeated
 * searches in a running daemon must not re-ask.
 */
const githubStarsCache = new Map<string, number>();

/**
 * Fill in the popularity numbers a candidate doesn't carry yet:
 * GitHub stars of its repository, Docker Hub pulls of its image,
 * npm / PyPI downloads of its package. Failed lookups become notes.
 *
 * @param candidate The candidate (Docker catalog entries already carry stars/pulls).
 * @returns The candidate with merged popularity.
 */
export async function withPopularity(candidate: McpSearchCandidate): Promise<McpSearchCandidate> {
    const notes = [...candidate.popularity.notes];
    let { githubStars, dockerPulls, monthlyDownloads } = candidate.popularity;

    const repository = candidate.repository;
    if (githubStars === undefined && repository !== undefined) {
        githubStars = await lookup(
            () => fetchGithubStars(repository.owner, repository.repo),
            "GitHub stars",
            notes,
        );
    }
    const { source, identifier } = candidate.install;
    if (dockerPulls === undefined && source === "docker-mcp-registry") {
        dockerPulls = await lookup(
            () => fetchDockerHubPulls(identifier),
            "Docker Hub pulls",
            notes,
        );
    }
    if (monthlyDownloads === undefined && source === "npm") {
        monthlyDownloads = await lookup(
            () => fetchNpmDownloads(identifier),
            "npm downloads",
            notes,
        );
    }
    if (monthlyDownloads === undefined && source === "pypi") {
        monthlyDownloads = await lookup(
            () => fetchPypiDownloads(identifier),
            "PyPI downloads",
            notes,
        );
    }
    const popularity: PopularitySignals = { githubStars, dockerPulls, monthlyDownloads, notes };
    return { ...candidate, popularity };
}

/**
 * Run one lookup; a failure becomes a note instead of an error.
 *
 * @param run The lookup.
 * @param label What was looked up (for the note).
 * @param notes Notes to append to.
 * @returns The number, or undefined when unknown.
 */
async function lookup(
    run: () => Promise<number | null>,
    label: string,
    notes: string[],
): Promise<number | undefined> {
    try {
        return (await run()) ?? undefined;
    } catch (err) {
        const cause =
            err instanceof HttpStatusError && (err.status === 403 || err.status === 429)
                ? "rate limited"
                : err instanceof Error
                  ? err.message
                  : String(err);
        notes.push(`${label} unknown (${cause}).`);
        return undefined;
    }
}

/**
 * Stargazer count of a GitHub repository.
 *
 * @param owner Repository owner.
 * @param repo Repository name.
 * @returns The star count, or `null` when the repository doesn't exist.
 * @throws Error on API failures (rate limit included).
 */
async function fetchGithubStars(owner: string, repo: string): Promise<number | null> {
    const key = `${owner}/${repo}`.toLowerCase();
    const cached = githubStarsCache.get(key);
    if (cached !== undefined) {
        return cached;
    }
    let body: unknown;
    try {
        body = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, {
            accept: "application/vnd.github+json",
        });
    } catch (err) {
        if (err instanceof HttpStatusError && err.status === 404) {
            return null;
        }
        throw err;
    }
    const stars = isMapping(body) ? optionalNumber(body.stargazers_count) : undefined;
    if (stars === undefined) {
        return null;
    }
    githubStarsCache.set(key, stars);
    return stars;
}

/**
 * npm downloads of the last month.
 *
 * @param name Package name, scoped or not.
 * @returns The count, or `null` for an unknown package.
 * @throws Error on API failures.
 */
async function fetchNpmDownloads(name: string): Promise<number | null> {
    try {
        const body = await fetchJson(`https://api.npmjs.org/downloads/point/last-month/${name}`);
        return isMapping(body) ? (optionalNumber(body.downloads) ?? null) : null;
    } catch (err) {
        if (err instanceof HttpStatusError && err.status === 404) {
            return null;
        }
        throw err;
    }
}

/**
 * PyPI downloads of the last month (pypistats.org).
 *
 * @param name Package name.
 * @returns The count, or `null` for an unknown package.
 * @throws Error on API failures.
 */
async function fetchPypiDownloads(name: string): Promise<number | null> {
    try {
        const body = await fetchJson(
            `https://pypistats.org/api/packages/${encodeURIComponent(name.toLowerCase())}/recent`,
        );
        const data = isMapping(body) && isMapping(body.data) ? body.data : undefined;
        return data !== undefined ? (optionalNumber(data.last_month) ?? null) : null;
    } catch (err) {
        if (err instanceof HttpStatusError && err.status === 404) {
            return null;
        }
        throw err;
    }
}
