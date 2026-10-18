/**
 * Who published an MCP registry entry, as far as the registry itself
 * vouches for it. The official MCP registry only accepts a server
 * name whose reverse-DNS namespace the publisher proved: `io.github.<user>/…`
 * requires a GitHub login as `<user>`, `com.vendor/…` requires DNS
 * (or HTTP) ownership of `vendor.com`.
 */
export interface PublisherIdentity {
    /** `github` for `io.github.<user>/…`, `dns` for every other namespace. */
    readonly kind: "github" | "dns";
    /** Lowercased comparison key: the GitHub login, or the domain's main label (`notion` for `com.notion`). */
    readonly key: string;
    /** Human form: `GitHub user "foo"` or `domain notion.com`. */
    readonly display: string;
}

/** Name tokens that say nothing about the service an MCP targets. */
const GENERIC_NAME_TOKENS: ReadonlySet<string> = new Set([
    "mcp",
    "server",
    "servers",
    "official",
    "remote",
    "the",
    "and",
    "for",
    "api",
    "tools",
    "connector",
    "integration",
    "model",
    "context",
    "protocol",
]);

/**
 * Parse the verified publisher out of an official-registry server name.
 *
 * @param serverName Reverse-DNS name, e.g. `io.github.github/github-mcp-server` or `com.notion/mcp`.
 * @returns The identity, or `null` when the name has no `namespace/name` shape.
 */
export function parsePublisherIdentity(serverName: string): PublisherIdentity | null {
    const slash = serverName.indexOf("/");
    if (slash <= 0) {
        return null;
    }
    const labels = serverName
        .slice(0, slash)
        .toLowerCase()
        .split(".")
        .filter((label) => label.length > 0);
    if (labels.length >= 3 && labels[0] === "io" && labels[1] === "github") {
        const login = labels.slice(2).join(".");
        return { kind: "github", key: login, display: `GitHub user "${login}"` };
    }
    if (labels.length < 2) {
        return null;
    }
    const domain = [...labels].reverse().join(".");
    return { kind: "dns", key: labels[1] as string, display: `domain ${domain}` };
}

/**
 * Split free text into lowercase alphanumeric tokens.
 *
 * @param text Any text (names, titles, search terms).
 * @returns The tokens in order, empty ones dropped.
 */
export function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 0);
}

/**
 * Tokens of an entry's name and title that can name a service —
 * {@link tokenize} minus generic scaffolding like `mcp` / `server`.
 *
 * @param parts Name tail, title, …
 * @returns The distinct service tokens.
 */
export function serviceTokens(...parts: readonly (string | undefined)[]): Set<string> {
    const tokens = new Set<string>();
    for (const part of parts) {
        if (part === undefined) {
            continue;
        }
        for (const token of tokenize(part)) {
            if (!GENERIC_NAME_TOKENS.has(token) && token.length > 1) {
                tokens.add(token);
            }
        }
    }
    return tokens;
}

/**
 * Main label of a URL's host (`notion` for `https://mcp.notion.com/mcp`).
 * Naive: takes the label left of the TLD, so `co.uk`-style suffixes come
 * out as `co` — good enough for a comparison signal.
 *
 * @param url Absolute URL.
 * @returns The lowercased label, or `null` for an unparsable URL or a bare host.
 */
export function hostMainLabel(url: string): string | null {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
    const labels = host.split(".").filter((label) => label.length > 0);
    if (labels.length < 2) {
        return null;
    }
    return labels[labels.length - 2] as string;
}

/**
 * Owner segment of a GitHub repository URL.
 *
 * @param url Repository URL, e.g. `https://github.com/github/github-mcp-server.git`.
 * @returns `{owner, repo}` lowercased-owner form, or `null` for non-GitHub URLs.
 */
export function parseGithubRepo(url: string | undefined): { owner: string; repo: string } | null {
    if (url === undefined) {
        return null;
    }
    const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i.exec(url);
    if (match === null) {
        return null;
    }
    const owner = (match[1] as string).toLowerCase();
    const repo = (match[2] as string).replace(/\.git$/i, "");
    return { owner, repo };
}

/**
 * Ref and subfolder of a GitHub tree URL, e.g. the Docker catalog's
 * pinned `source` (`https://github.com/awslabs/mcp/tree/780e3f1/src/core-mcp-server`).
 *
 * @param url The URL.
 * @returns `{ref, subfolder?}`, or `null` when it is not a `/tree/<ref>` URL.
 */
export function parseGithubTreeUrl(
    url: string | undefined,
): { ref: string; subfolder?: string } | null {
    if (url === undefined) {
        return null;
    }
    const match =
        /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/tree\/([^/#?]+)(?:\/([^#?]+))?/i.exec(
            url,
        );
    if (match === null) {
        return null;
    }
    const subfolder = match[2]?.replace(/\/+$/, "");
    return subfolder ? { ref: match[1] as string, subfolder } : { ref: match[1] as string };
}
