import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { imageNamespace, parseImageReference } from "./ImagePlatforms.js";
import { hostMainLabel, parseGithubRepo, parsePublisherIdentity } from "./PublisherIdentity.js";
import type { McpSearchCandidate } from "./SearchCandidate.js";
import { rateCandidate, renderStars } from "./SecurityRating.js";

/**
 * Build a candidate with defaults for the fields a test doesn't care about.
 *
 * @param overrides Fields to set.
 * @returns The candidate.
 */
function candidate(overrides: Partial<McpSearchCandidate>): McpSearchCandidate {
    return {
        registry: "official",
        name: "io.github.someone/thing",
        title: "thing",
        description: "",
        tier: "registry-only",
        install: { source: "npm", identifier: "thing", requirements: [] },
        alternativeInstalls: 0,
        publisher: null,
        popularity: { notes: [] },
        ...overrides,
    };
}

describe("parsePublisherIdentity", () => {
    it("reads a GitHub-login namespace", () => {
        assert.deepEqual(parsePublisherIdentity("io.github.GitHub/github-mcp-server"), {
            kind: "github",
            key: "github",
            display: 'GitHub user "github"',
        });
    });

    it("reads a DNS namespace", () => {
        assert.deepEqual(parsePublisherIdentity("com.notion/mcp"), {
            kind: "dns",
            key: "notion",
            display: "domain notion.com",
        });
    });

    it("returns null without a namespace", () => {
        assert.equal(parsePublisherIdentity("fetch"), null);
    });
});

describe("URL helpers", () => {
    it("takes the main host label", () => {
        assert.equal(hostMainLabel("https://mcp.notion.com/mcp"), "notion");
        assert.equal(hostMainLabel("not a url"), null);
    });

    it("parses GitHub repository URLs", () => {
        assert.deepEqual(parseGithubRepo("https://github.com/N24q02m/better-notion-mcp.git"), {
            owner: "n24q02m",
            repo: "better-notion-mcp",
        });
        assert.equal(parseGithubRepo("https://gitlab.com/a/b"), null);
    });
});

describe("parseImageReference", () => {
    it("splits registry, repository, tag and digest", () => {
        assert.deepEqual(parseImageReference("armlimited/arm-mcp:2.4.0@sha256:abc"), {
            registry: "docker.io",
            repository: "armlimited/arm-mcp",
            tag: "2.4.0",
            digest: "sha256:abc",
        });
        assert.deepEqual(parseImageReference("ghcr.io/github/github-mcp-server@sha256:ff"), {
            registry: "ghcr.io",
            repository: "github/github-mcp-server",
            tag: undefined,
            digest: "sha256:ff",
        });
    });

    it("expands official Docker Hub images to library/", () => {
        assert.equal(parseImageReference("alpine").repository, "library/alpine");
    });

    it("derives the namespace", () => {
        assert.equal(imageNamespace("mcp/notion@sha256:x"), "docker.io/mcp");
        assert.equal(imageNamespace("docker.io/n24q02m/better:latest"), "docker.io/n24q02m");
        assert.equal(imageNamespace("ghcr.io/github/github-mcp-server"), "ghcr.io/github");
    });
});

describe("rateCandidate", () => {
    it("gives docker-built a fixed 5 even with low adoption", () => {
        const rating = rateCandidate(
            candidate({
                registry: "docker",
                name: "fetch",
                tier: "docker-built",
                install: {
                    source: "docker-mcp-registry",
                    identifier: "mcp/fetch",
                    requirements: [],
                },
                popularity: { githubStars: 3, dockerPulls: 10, notes: [] },
            }),
            "fetch",
        );
        assert.equal(rating.stars, 5);
        assert.ok(rating.findings.every((finding, index) => index === 0 || finding.effect === 0));
    });

    it("flags a DNS publisher matching the searched service as first party", () => {
        const rating = rateCandidate(
            candidate({
                name: "com.notion/mcp",
                title: "mcp",
                publisher: parsePublisherIdentity("com.notion/mcp"),
                install: {
                    source: "external",
                    identifier: "https://mcp.notion.com/mcp",
                    requirements: [],
                },
                remoteUrl: "https://mcp.notion.com/mcp",
            }),
            "notion",
        );
        assert.equal(rating.firstParty, "yes");
        assert.equal(rating.stars, 3);
    });

    it("treats an aggregator proxy named after itself as third party when the user searched the service", () => {
        const rating = rateCandidate(
            candidate({
                name: "ai.smithery/smithery-notion",
                title: "smithery-notion",
                publisher: parsePublisherIdentity("ai.smithery/smithery-notion"),
            }),
            "notion",
        );
        assert.equal(rating.firstParty, "no");
        assert.equal(rating.stars, 1);
    });

    it("penalizes all-low adoption for registry-only entries, floored at 0", () => {
        const rating = rateCandidate(
            candidate({
                publisher: parsePublisherIdentity("io.github.someone/thing"),
                popularity: { githubStars: 2, monthlyDownloads: 50, notes: [] },
            }),
            "notion",
        );
        assert.equal(rating.stars, 0);
    });

    it("caps community images at 4 and says so", () => {
        const rating = rateCandidate(
            candidate({
                registry: "docker",
                name: "github-official",
                title: "GitHub Official",
                tier: "docker-community-image",
                owner: "github",
                imageNamespace: "ghcr.io/github",
                repository: {
                    owner: "github",
                    repo: "github-mcp-server",
                    url: "https://github.com/github/github-mcp-server",
                },
                install: {
                    source: "docker-mcp-registry",
                    identifier: "ghcr.io/github/github-mcp-server",
                    requirements: [],
                },
                popularity: { githubStars: 30_000, notes: [] },
            }),
            "github",
        );
        assert.equal(rating.stars, 4);
        assert.equal(rating.firstParty, "yes");
        assert.match(rating.findings.at(-1)?.text ?? "", /Capped at 4\/5/);
    });

    it("renders stars", () => {
        assert.equal(renderStars(3), "★★★☆☆ 3/5");
    });
});
