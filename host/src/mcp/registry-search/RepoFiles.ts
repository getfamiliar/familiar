import { fetchWithTimeout, HttpStatusError } from "./RegistryHttp.js";

/** Where a server's code lives on GitHub. */
export interface RepoLocation {
    readonly owner: string;
    readonly repo: string;
    /** Commit, branch or `HEAD`. */
    readonly ref: string;
    /** Path of the server in a monorepo. */
    readonly subfolder?: string;
}

/** Raw (unsanitized) repository files; each absent when the repo has none. */
export interface RepoFiles {
    readonly readme?: string;
    readonly envExample?: string;
    readonly dockerfile?: string;
    /** Fetch failures other than "file does not exist". */
    readonly notes: readonly string[];
}

/** README spellings tried in order. */
const README_NAMES = ["README.md", "readme.md", "Readme.md", "README.MD", "README"];

/** Largest file read; anything bigger is cut. */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Read README, `.env.example` and Dockerfile of a server's repository
 * from raw.githubusercontent.com (no API rate limit). In a monorepo the
 * subfolder is tried first, then the repository root. A README that no
 * known spelling finds falls back to the GitHub API's `/readme`.
 *
 * @param location Repository, ref and subfolder.
 * @returns The files that exist, plus notes on failed requests.
 */
export async function fetchRepoFiles(location: RepoLocation): Promise<RepoFiles> {
    const notes: string[] = [];
    const folders =
        location.subfolder !== undefined && location.subfolder.length > 0
            ? [location.subfolder, ""]
            : [""];
    const findFirst = async (names: readonly string[]): Promise<string | undefined> => {
        for (const folder of folders) {
            for (const name of names) {
                const text = await fetchRawFile(location, folder, name, notes);
                if (text !== undefined) {
                    return text;
                }
            }
        }
        return undefined;
    };
    const [readme, envExample, dockerfile] = await Promise.all([
        findFirst(README_NAMES),
        findFirst([".env.example", ".env.sample"]),
        findFirst(["Dockerfile"]),
    ]);
    return {
        readme: readme ?? (await fetchApiReadme(location, notes)),
        envExample,
        dockerfile,
        notes,
    };
}

/**
 * GET one raw file.
 *
 * @param location Repository and ref.
 * @param folder Folder inside the repository (`""` for the root).
 * @param name File name.
 * @param notes Failure notes to append to.
 * @returns The text, or undefined when missing or failed.
 */
async function fetchRawFile(
    location: RepoLocation,
    folder: string,
    name: string,
    notes: string[],
): Promise<string | undefined> {
    const path = [folder, name].filter((part) => part.length > 0).join("/");
    const url = `https://raw.githubusercontent.com/${location.owner}/${location.repo}/${location.ref}/${path}`;
    try {
        const response = await fetchWithTimeout(url);
        if (response.status === 404) {
            return undefined;
        }
        if (!response.ok) {
            notes.push(
                `${path}: ${new HttpStatusError(url, response.status, response.statusText).message}.`,
            );
            return undefined;
        }
        return capped(await response.text());
    } catch (err) {
        notes.push(`${path}: ${err instanceof Error ? err.message : String(err)}.`);
        return undefined;
    }
}

/**
 * README via the GitHub API, which finds any spelling/extension
 * (`README.rst`, …). Rate limited (60/h anonymously), hence the fallback.
 *
 * @param location Repository and ref.
 * @param notes Failure notes to append to.
 * @returns The text, or undefined.
 */
async function fetchApiReadme(
    location: RepoLocation,
    notes: string[],
): Promise<string | undefined> {
    const folder = location.subfolder !== undefined ? `/${location.subfolder}` : "";
    const url = `https://api.github.com/repos/${location.owner}/${location.repo}/readme${folder}?ref=${encodeURIComponent(location.ref)}`;
    try {
        const response = await fetchWithTimeout(url, { accept: "application/vnd.github.raw" });
        if (response.status === 404) {
            return undefined;
        }
        if (!response.ok) {
            notes.push(
                `README lookup via GitHub API: ${response.status === 403 || response.status === 429 ? "rate limited" : `${response.status} ${response.statusText}`}.`,
            );
            return undefined;
        }
        return capped(await response.text());
    } catch (err) {
        notes.push(
            `README lookup via GitHub API: ${err instanceof Error ? err.message : String(err)}.`,
        );
        return undefined;
    }
}

/**
 * Cut a file at {@link MAX_FILE_BYTES} characters.
 *
 * @param text File content.
 * @returns The (possibly cut) content.
 */
function capped(text: string): string {
    return text.length > MAX_FILE_BYTES
        ? `${text.slice(0, MAX_FILE_BYTES)}\n\n[cut at ${MAX_FILE_BYTES} characters]`
        : text;
}
