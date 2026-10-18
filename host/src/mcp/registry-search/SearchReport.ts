import { markdownTable } from "@getfamiliar/shared";
import { proposeId } from "../registries/RegistryEntry.js";
import type { PublisherIdentity } from "./PublisherIdentity.js";
import type { InstallPlan, McpSearchResult, RatedCandidate } from "./SearchCandidate.js";
import { formatCount, renderStars } from "./SecurityRating.js";

/** Description length in the table before it is cut. */
const DESCRIPTION_MAX_LENGTH = 110;

/**
 * Render a search result as markdown: the candidate table, one findings
 * block per candidate (the reasons behind its stars), and the count of
 * filtered-out entries — listed with their reasons when `isVerbose`.
 * The CLI (`tools search-mcp`) and the agent tool (`mcp_registry_search`)
 * both print exactly this.
 *
 * @param result The search result.
 * @param isVerbose Whether to list the filtered-out entries.
 * @returns The markdown.
 */
export function renderSearchReport(result: McpSearchResult, isVerbose: boolean): string {
    const lines: string[] = [`# MCP registry search: "${result.query}"`, ""];
    for (const warning of result.warnings) {
        lines.push(`> **Warning:** ${warning}`, "");
    }

    if (result.candidates.length === 0) {
        lines.push(`No suitable MCP server found for ${result.platform}.`, "");
    } else {
        lines.push(
            `Suitable for ${result.platform}, best rated first. Security stars: provenance tier sets the base (docker-built = 5/5), publisher identity and popularity adjust it.`,
            "",
            markdownTable(
                ["#", "Name", "Security", "Provenance", "Install", "Adoption", "Description"],
                result.candidates.map((candidate, index) => [
                    String(index + 1),
                    candidate.name,
                    renderStars(candidate.rating.stars),
                    candidate.rating.firstParty === "yes"
                        ? `${candidate.tier}, first party`
                        : candidate.tier,
                    installCell(candidate.install),
                    adoptionCell(candidate),
                    truncate(candidate.description || candidate.title),
                ]),
            ),
        );
        if (result.omittedCount > 0) {
            lines.push(
                `${result.omittedCount} more suitable MCP server(s) not shown — raise the limit or use a more specific term.`,
                "",
            );
        }
        lines.push("## Findings", "");
        result.candidates.forEach((candidate, index) => {
            lines.push(...renderFindings(candidate, index + 1), "");
        });
    }

    const filteredCount = result.excluded.length;
    if (filteredCount === 0) {
        lines.push("No MCP servers were filtered out.");
    } else if (!isVerbose) {
        lines.push(
            `${filteredCount} matching MCP server(s) filtered out as unsuitable (unsupported package type, auth-gated remote, deprecated/deleted, no ${result.platform} image, or duplicate of a Docker catalog entry) — run with verbose (\`-v\`) to list them with reasons.`,
        );
    } else {
        lines.push(
            `## Filtered out (${filteredCount})`,
            "",
            markdownTable(
                ["Registry", "Name", "Reason"],
                result.excluded.map((entry) => [entry.registry, entry.name, entry.reason]),
            ),
        );
    }
    return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Findings block for one candidate: heading with stars, the rating's
 * findings with their star effect, then install facts.
 *
 * @param candidate The rated candidate.
 * @param position Its row number in the table.
 * @returns Markdown lines.
 */
function renderFindings(candidate: RatedCandidate, position: number): string[] {
    return [
        `### ${position}. ${candidate.name} — ${renderStars(candidate.rating.stars)}`,
        "",
        ...renderCandidateFacts(candidate),
    ];
}

/**
 * The rating's findings with their star effect, then install facts —
 * shared by the search report and `mcp_registry_details`.
 *
 * @param candidate The rated candidate.
 * @returns Markdown list lines.
 */
export function renderCandidateFacts(candidate: RatedCandidate): string[] {
    const lines: string[] = [];
    candidate.rating.findings.forEach((finding, index) => {
        const label =
            index === 0
                ? `base ${finding.effect}`
                : finding.effect > 0
                  ? `+${finding.effect}`
                  : finding.effect < 0
                    ? `−${-finding.effect}`
                    : "·";
        lines.push(`- **${label}** ${finding.text}`);
    });
    const plan = candidate.install;
    const installParts = [`source \`${plan.source}\``];
    if (plan.source === "docker-mcp-registry") {
        installParts.push(`image \`${plan.identifier}\``);
    } else if (plan.source === "external") {
        installParts.push(`url \`${plan.identifier}\``);
    } else {
        installParts.push(`package \`${plan.identifier}\``);
        if (plan.version !== undefined) {
            installParts.push(`version \`${plan.version}\``);
        }
    }
    installParts.push(`suggested id \`${suggestedId(candidate)}\``);
    lines.push(`- Install: ${installParts.join(", ")}.`);
    if (candidate.alternativeInstalls > 0) {
        lines.push(
            `- ${candidate.alternativeInstalls} other install variant(s) published (preference: image, npm, pypi, remote).`,
        );
    }
    lines.push(
        `- Needs: ${plan.requirements.length > 0 ? plan.requirements.join(", ") : "nothing declared"}.`,
    );
    if (plan.source === "external") {
        lines.push(
            "- Remote endpoint: no auth declared — if it asks for an OAuth login, the `external` source can't do that.",
        );
    }
    if (candidate.platforms !== undefined) {
        lines.push(`- Image platforms: ${candidate.platforms.join(", ")}.`);
    } else if (candidate.platformNote !== undefined) {
        lines.push(`- Image ${candidate.platformNote}.`);
    }
    if (candidate.repository !== undefined) {
        lines.push(`- Source: ${candidate.repository.url}`);
    }
    return lines;
}

/**
 * Local `mcp.yml` id to propose: {@link proposeId} of the name, or the
 * publisher's key when the name is pure scaffolding (`com.notion/mcp`).
 * Leading digits are dropped — ids must start with a letter.
 *
 * @param candidate The candidate (or any entry with name, publisher and owner).
 * @returns The id.
 */
export function suggestedId(candidate: {
    readonly name: string;
    readonly publisher?: PublisherIdentity | null;
    readonly owner?: string;
}): string {
    const proposed = proposeId(candidate.name);
    const fallback = candidate.publisher?.key ?? candidate.owner;
    const id =
        proposed === "mcpserver" && fallback !== undefined
            ? fallback.replace(/[^a-z0-9]/g, "")
            : proposed;
    return id.replace(/^[0-9]+/, "") || "mcpserver";
}

/**
 * Short install identifier for the table.
 *
 * @param plan The install plan.
 * @returns E.g. `mcp/notion`, `npm:foo`, `pypi:bar`, or the URL.
 */
function installCell(plan: InstallPlan): string {
    if (plan.source === "npm" || plan.source === "pypi") {
        return `${plan.source}:${plan.identifier}`;
    }
    return plan.identifier;
}

/**
 * Popularity numbers for the table.
 *
 * @param candidate The candidate.
 * @returns E.g. `268k pulls, 4.7k GitHub ★`, or `–`.
 */
function adoptionCell(candidate: RatedCandidate): string {
    const parts: string[] = [];
    const { githubStars, dockerPulls, monthlyDownloads } = candidate.popularity;
    if (dockerPulls !== undefined) {
        parts.push(`${formatCount(dockerPulls)} pulls`);
    }
    if (monthlyDownloads !== undefined) {
        parts.push(`${formatCount(monthlyDownloads)} dl/month`);
    }
    if (githubStars !== undefined) {
        parts.push(`${formatCount(githubStars)} GitHub ★`);
    }
    return parts.length > 0 ? parts.join(", ") : "–";
}

/**
 * Cut text to the table width.
 *
 * @param text The text.
 * @returns The text, cut with an ellipsis when too long.
 */
function truncate(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > DESCRIPTION_MAX_LENGTH
        ? `${flat.slice(0, DESCRIPTION_MAX_LENGTH - 1)}…`
        : flat;
}
