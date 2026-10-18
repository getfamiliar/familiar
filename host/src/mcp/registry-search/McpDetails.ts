import {
    describeCatalogEntry,
    getDockerCatalogEntry,
    mapCatalogEntry,
} from "./DockerCatalogSearch.js";
import { detectContainerPlatform } from "./ImagePlatforms.js";
import { checkPlatform, errorText, firstFittingVariant } from "./McpRegistrySearch.js";
import {
    describeOfficialServer,
    fetchOfficialServer,
    mapOfficialServer,
} from "./OfficialRegistrySearch.js";
import { withPopularity } from "./PopularityLookup.js";
import { fetchRepoFiles, type RepoFiles } from "./RepoFiles.js";
import type {
    ExcludedEntry,
    McpDetailsSubject,
    McpSearchCandidate,
    RatedCandidate,
} from "./SearchCandidate.js";
import { rateCandidate } from "./SecurityRating.js";
import { fetchCatalogTools, type PublishedTool } from "./ToolCatalog.js";

/** Neither registry knows the requested name. */
export class McpNotFoundError extends Error {
    /**
     * @param name The requested name.
     * @param registry Where it was looked up.
     */
    constructor(name: string, registry: "docker" | "official") {
        super(
            registry === "docker"
                ? `the Docker MCP catalog has no server "${name}" (official-registry names contain a "/", e.g. com.notion/mcp)`
                : `the official MCP registry has no server "${name}"`,
        );
        this.name = "McpNotFoundError";
    }
}

/** Options of {@link lookupMcpDetails}. */
export interface McpDetailsOptions {
    /** Docker catalog key (`notion`) or official name (`com.notion/mcp`), as `mcp_registry_search` lists it. */
    readonly name: string;
    /** The service the user is after — feeds the first-party check like the search term does. */
    readonly query?: string;
    /** `os/arch` for the image check; default: the docker engine's. */
    readonly platform?: string;
}

/** Everything `mcp_registry_details` reports about one server. */
export interface McpDetails {
    readonly subject: McpDetailsSubject;
    readonly platform: string;
    /** The rated candidate, or `null` when the server is not suitable. */
    readonly candidate: RatedCandidate | null;
    /** Why the server is not suitable, when it isn't. */
    readonly unsuitableReason: string | null;
    /** Published tools, or `null` when the registry publishes none. */
    readonly tools: readonly PublishedTool[] | null;
    /** Why the tool list is missing or partial. */
    readonly toolsNote?: string;
    /** Raw repository files, or `null` without a GitHub repository. */
    readonly files: RepoFiles | null;
}

/**
 * Collect the facts an agent needs to plan an MCP setup: registry entry,
 * rating (same as the search), settings, published tools and the
 * repository's README / `.env.example` / Dockerfile. Unsuitable servers
 * are described too, with the reason.
 *
 * @param options Name, query, platform.
 * @returns The details (repository files still raw — the report sanitizes them).
 * @throws McpNotFoundError when the registry doesn't know the name; Error on registry failures.
 */
export async function lookupMcpDetails(options: McpDetailsOptions): Promise<McpDetails> {
    const name = options.name.trim();
    const platform = options.platform ?? (await detectContainerPlatform());
    let subject: McpDetailsSubject;
    let fitting: McpSearchCandidate | ExcludedEntry;
    if (name.includes("/")) {
        const found = await fetchOfficialServer(name);
        if (found === null) {
            throw new McpNotFoundError(name, "official");
        }
        subject = describeOfficialServer(found.server, found.status);
        const mapped = mapOfficialServer(found.server, found.status);
        fitting =
            "reason" in mapped ? mapped : await firstFittingVariant(mapped.variants, platform);
    } else {
        const entry = await getDockerCatalogEntry(name);
        if (entry === null) {
            throw new McpNotFoundError(name, "docker");
        }
        subject = describeCatalogEntry(name, entry);
        const mapped = mapCatalogEntry(name, entry);
        fitting = "reason" in mapped ? mapped : await checkPlatform(mapped, platform);
    }

    const [candidate, toolsResult, files] = await Promise.all([
        "reason" in fitting
            ? Promise.resolve(null)
            : withPopularity(fitting).then((enriched) => ({
                  ...enriched,
                  rating: rateCandidate(enriched, options.query ?? ""),
              })),
        loadTools(subject),
        subject.repository !== undefined
            ? fetchRepoFiles({
                  owner: subject.repository.owner,
                  repo: subject.repository.repo,
                  ref: subject.repositoryRef,
                  subfolder: subject.repositorySubfolder,
              })
            : Promise.resolve(null),
    ]);
    return {
        subject,
        platform,
        candidate,
        unsuitableReason: "reason" in fitting ? fitting.reason : null,
        tools: toolsResult.tools,
        toolsNote: toolsResult.note,
        files,
    };
}

/**
 * The server's published tools: the Docker catalog's tool list, else its
 * inlined tool names; official-registry servers publish none.
 *
 * @param subject The registry facts.
 * @returns The tools (or `null`) and a note on what is missing.
 */
async function loadTools(
    subject: McpDetailsSubject,
): Promise<{ tools: PublishedTool[] | null; note?: string }> {
    const fromNames = (): PublishedTool[] =>
        subject.inlineToolNames.map((toolName) => ({
            name: toolName,
            description: "",
            parameters: [],
        }));
    if (subject.toolsUrl !== undefined) {
        try {
            return { tools: await fetchCatalogTools(subject.toolsUrl) };
        } catch (err) {
            const note = `tool details not loaded (${errorText(err)})`;
            return subject.inlineToolNames.length > 0
                ? { tools: fromNames(), note }
                : { tools: null, note };
        }
    }
    if (subject.inlineToolNames.length > 0) {
        return { tools: fromNames(), note: "only tool names are published" };
    }
    return {
        tools: null,
        note:
            subject.registry === "official"
                ? "the official MCP registry publishes no tool lists"
                : "the Docker catalog lists no tools for this server (remote servers report them only when connected)",
    };
}
