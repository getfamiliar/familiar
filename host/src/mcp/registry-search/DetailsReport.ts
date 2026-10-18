import { markdownTable } from "@getfamiliar/shared";
import { markdownToPlainText, sanitizeExternalText } from "../../utils/ExternalTextSanitizer.js";
import type { McpDetails } from "./McpDetails.js";
import type { EnvVarSpec } from "./SearchCandidate.js";
import { renderCandidateFacts, suggestedId } from "./SearchReport.js";
import { renderStars } from "./SecurityRating.js";
import type { PublishedTool } from "./ToolCatalog.js";

/**
 * Store an over-long section and return where it went
 * (`/scratch/<event>/…` for the agent, a host path for the CLI).
 */
export type SectionSpill = (fileName: string, content: string) => Promise<string>;

/** Inline budget per section, in characters; larger sections are spilled. */
const README_BUDGET = 8000;
const TOOLS_BUDGET = 12_000;
const FILE_BUDGET = 3000;

/** README characters kept inline when the README is spilled. */
const README_PREVIEW = 1500;

/** Setting names that grant broad cloud access — suspicious unless the server is about that cloud. */
const BROAD_CREDENTIAL_PATTERN =
    /^(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|AWS_SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|GCP_.*KEY.*|AZURE_CLIENT_SECRET|AZURE_.*KEY.*|.*PRIVATE_KEY.*|.*SSH_KEY.*|KUBECONFIG)$/i;

/**
 * Render `mcp_registry_details` / `familiar tools mcp-details` output:
 * header (rating and install facts as in the search), description,
 * settings table, architecture hints, tools, README, `.env.example`,
 * Dockerfile. Repository files are sanitized here (the README becomes
 * plain text); sections over budget go to `spill`.
 *
 * @param details The looked-up details.
 * @param spill Stores a long section, returns its path.
 * @returns The markdown.
 */
export async function renderDetailsReport(
    details: McpDetails,
    spill: SectionSpill,
): Promise<string> {
    const { subject, candidate } = details;
    const readme =
        details.files?.readme !== undefined ? markdownToPlainText(details.files.readme) : undefined;
    const envExample =
        details.files?.envExample !== undefined
            ? sanitizeExternalText(details.files.envExample)
            : undefined;
    const dockerfile =
        details.files?.dockerfile !== undefined
            ? sanitizeExternalText(details.files.dockerfile)
            : undefined;

    const lines: string[] = [`# MCP details: ${subject.name}`, ""];
    const facts = [
        `- **Title:** ${subject.title}`,
        `- **Registry:** ${subject.registry === "docker" ? "Docker MCP catalog" : "official MCP registry"}`,
        `- **Version:** ${subject.version ?? "not published"}`,
    ];
    if (candidate !== null) {
        facts.push(`- **Provenance tier:** ${candidate.tier}`);
        facts.push(`- **Security:** ${renderStars(candidate.rating.stars)}`);
    }
    const status = [
        subject.lifecycleStatus !== undefined
            ? `lifecycle \`${subject.lifecycleStatus}\``
            : undefined,
        candidate !== null
            ? `suitable for ${details.platform}`
            : `**not suitable:** ${details.unsuitableReason ?? "unknown reason"}`,
        candidate?.platformNote,
    ].filter((part): part is string => part !== undefined);
    facts.push(`- **Status:** ${status.join("; ")}`);
    if (subject.repository !== undefined) {
        const location = [
            subject.repositoryRef !== "HEAD" ? `@ ${subject.repositoryRef}` : undefined,
            subject.repositorySubfolder !== undefined
                ? `folder \`${subject.repositorySubfolder}\``
                : undefined,
        ].filter((part): part is string => part !== undefined);
        facts.push(
            `- **Repository:** ${subject.repository.url}${location.length > 0 ? ` (${location.join(", ")})` : ""}`,
        );
    }
    if (candidate === null) {
        facts.push(`- **Suggested id:** \`${suggestedId(subject)}\``);
    }
    lines.push(...facts, "");

    if (candidate !== null) {
        lines.push("## Rating and install facts", "", ...renderCandidateFacts(candidate), "");
    }

    lines.push("## Description", "", subject.description || "No description published.", "");

    lines.push(...renderSettings(details), "");
    lines.push(...renderHints(details, readme, dockerfile), "");
    lines.push(...(await renderTools(details, spill)), "");

    lines.push("## README", "");
    if (readme === undefined || readme.length === 0) {
        lines.push(
            subject.repository === undefined
                ? "No GitHub repository published — README not available."
                : "No README found in the repository.",
        );
    } else if (readme.length <= README_BUDGET) {
        lines.push(
            "Plain text, cleaned (images, HTML, comments and invisible characters removed):",
            "",
            readme,
        );
    } else {
        const path = await spill("readme.md", readme);
        lines.push(
            `The cleaned README has ${readme.length} characters and was saved to \`${path}\` — read it there. Beginning:`,
            "",
            `${readme.slice(0, README_PREVIEW).trimEnd()}\n[…]`,
        );
    }
    lines.push("");

    lines.push(
        ...(await renderFile(".env.example", "env.example", "dotenv", envExample, spill)),
        "",
    );
    lines.push(
        ...(await renderFile("Dockerfile", "Dockerfile.txt", "dockerfile", dockerfile, spill)),
        "",
    );

    const notes = details.files?.notes ?? [];
    if (notes.length > 0) {
        lines.push(
            "## Lookup notes",
            "",
            ...notes.map((note) => `- ${sanitizeExternalText(note)}`),
            "",
        );
    }
    return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Settings table for the chosen install variant (or every variant when
 * none fits).
 *
 * @param details The details.
 * @returns Markdown lines.
 */
function renderSettings(details: McpDetails): string[] {
    const lines = ["## Settings (environment variables, parameters, headers)", ""];
    const byInstall = details.subject.settingsByInstall;
    const chosen = details.candidate?.install.identifier;
    const entries =
        chosen !== undefined && byInstall.has(chosen)
            ? [[chosen, byInstall.get(chosen) ?? []] as const]
            : [...byInstall.entries()];
    const nonEmpty = entries.filter(([, settings]) => settings.length > 0);
    if (nonEmpty.length === 0) {
        lines.push("None declared by the registry — check the README and `.env.example` below.");
        return lines;
    }
    for (const [install, settings] of nonEmpty) {
        if (entries.length > 1) {
            lines.push(`For \`${install}\`:`, "");
        }
        lines.push(
            markdownTableTrimmed(
                ["Name", "Kind", "Secret", "Required", "Default / example", "Description"],
                settings.map((setting) => [
                    setting.name,
                    setting.kind,
                    setting.isSecret ? "yes" : "no",
                    setting.isRequired ? "yes" : "no",
                    setting.defaultValue ?? "",
                    setting.description ?? "",
                ]),
            ),
        );
    }
    return lines;
}

/**
 * Automatically spotted signals that matter for our architecture.
 *
 * @param details The details.
 * @param readme Cleaned README.
 * @param dockerfile Cleaned Dockerfile.
 * @returns Markdown lines.
 */
function renderHints(
    details: McpDetails,
    readme: string | undefined,
    dockerfile: string | undefined,
): string[] {
    const { subject } = details;
    const hints: string[] = [];
    const sources: [string, string][] = [
        ["README", readme ?? ""],
        ["Dockerfile", dockerfile ?? ""],
        ["catalog volumes", subject.volumes.join("\n")],
    ];
    const foundIn = (pattern: RegExp): string[] =>
        sources.filter(([, text]) => pattern.test(text)).map(([label]) => label);

    const dockerDaemon = foundIn(
        /docker\.sock|\/var\/run\/docker|DOCKER_HOST|docker daemon|docker-in-docker/i,
    );
    if (dockerDaemon.length > 0) {
        hints.push(
            `Docker daemon access mentioned (${dockerDaemon.join(", ")}): MCP containers here get no Docker socket — a server that starts containers itself cannot work.`,
        );
    }
    const oauth = foundIn(
        /oauth|browser (?:login|sign[- ]in|window)|in (?:your|the) browser|device[- ]code|--login\b|\bauth login\b/i,
    );
    if (oauth.length > 0) {
        hints.push(
            `Login/OAuth mentioned (${oauth.join(", ")}): check whether a token can be passed as an env var, or created once with a CLI login stored under \`/work\`; an interactive browser flow at runtime is not possible.`,
        );
    }
    if (subject.volumes.length > 0) {
        hints.push(
            `Needs host directories mounted (\`volumes\`): ${subject.volumes.map((v) => `\`${v}\``).join(", ")}.`,
        );
    }
    if (subject.allowHosts.length > 0) {
        hints.push(
            `Expected network egress: ${subject.allowHosts.map((h) => `\`${h}\``).join(", ")}.`,
        );
    }
    const settings = [...subject.settingsByInstall.values()].flat();
    const broad = [
        ...new Set(
            settings.filter((s) => BROAD_CREDENTIAL_PATTERN.test(s.name)).map((s) => s.name),
        ),
    ];
    if (broad.length > 0) {
        hints.push(
            `Broad credentials requested: ${broad.map((n) => `\`${n}\``).join(", ")} — only proportionate if the server is about that platform; prefer a narrowly scoped key.`,
        );
    }
    const headers = settings.filter((s: EnvVarSpec) => s.kind === "header" && s.isRequired);
    if (headers.length > 0) {
        hints.push(
            `Remote needs request headers (${headers.map((h) => `\`${h.name}\``).join(", ")}) — the \`external\` source can't send headers.`,
        );
    }
    if (details.candidate?.install.source === "external" && headers.length === 0) {
        hints.push(
            "Remote endpoint without declared auth — if it asks for an OAuth login when connecting, the `external` source can't do that.",
        );
    }
    return [
        "## Architecture hints",
        "",
        ...(hints.length > 0
            ? hints.map((hint) => `- ${hint}`)
            : [
                  "- Nothing automatically detected — still check auth, Docker use and setup steps in the README.",
              ]),
    ];
}

/**
 * Tools section: counts by annotation, then the table (spilled when long).
 *
 * @param details The details.
 * @param spill Stores a long section.
 * @returns Markdown lines.
 */
async function renderTools(details: McpDetails, spill: SectionSpill): Promise<string[]> {
    const tools = details.tools;
    if (tools === null || tools.length === 0) {
        return [
            "## Tools",
            "",
            `Tool list not published (${details.toolsNote ?? "no data"}) — derive the tools from the README, and verify with \`tool_list\` after \`config_reload\` before finalizing allowlist/denylist.`,
        ];
    }
    const readOnly = tools.filter((tool) => tool.readOnly === true).length;
    const destructive = tools.filter((tool) => tool.destructive === true).length;
    const unhinted = tools.filter(
        (tool) => tool.readOnly === undefined && tool.destructive === undefined,
    ).length;
    const lines = [
        `## Tools (${tools.length})`,
        "",
        `${readOnly} read-only, ${destructive} destructive, ${unhinted} without hints (hints are the publisher's own annotations).${details.toolsNote !== undefined ? ` Note: ${details.toolsNote}.` : ""}`,
        "",
    ];
    const table = markdownTableTrimmed(
        ["Tool", "Hints", "Parameters", "Description"],
        tools.map((tool) => [
            tool.name,
            toolHints(tool),
            toolParameters(tool),
            flatten(tool.description),
        ]),
    );
    if (table.length <= TOOLS_BUDGET) {
        lines.push(table);
        return lines;
    }
    const path = await spill("tools.md", `# Tools of ${details.subject.name}\n\n${table}`);
    lines.push(
        `The full table (with parameters and descriptions) is in \`${path}\`. Names: ${tools.map((tool) => `\`${tool.name}\``).join(", ")}.`,
    );
    return lines;
}

/**
 * A repository file as a code fence, spilled when long.
 *
 * @param title Section title.
 * @param spillName File name for the spill.
 * @param language Fence language.
 * @param content Cleaned content, undefined when absent.
 * @param spill Stores a long section.
 * @returns Markdown lines (empty when the file is absent).
 */
async function renderFile(
    title: string,
    spillName: string,
    language: string,
    content: string | undefined,
    spill: SectionSpill,
): Promise<string[]> {
    if (content === undefined || content.length === 0) {
        return [];
    }
    if (content.length > FILE_BUDGET) {
        const path = await spill(spillName, content);
        return [`## ${title}`, "", `${content.length} characters, saved to \`${path}\`.`];
    }
    const fence = content.includes("```") ? "````" : "```";
    return [`## ${title}`, "", `${fence}${language}`, content, fence];
}

/** Annotation summary for one tool. */
function toolHints(tool: PublishedTool): string {
    const hints: string[] = [];
    if (tool.readOnly === true) {
        hints.push("read-only");
    }
    if (tool.destructive === true) {
        hints.push("destructive");
    }
    if (tool.readOnly === false && tool.destructive !== true) {
        hints.push("writes");
    }
    return hints.join(", ") || "–";
}

/** Parameter list `name: type` for one tool. */
function toolParameters(tool: PublishedTool): string {
    return tool.parameters.map((p) => `${p.name}: ${p.type}`).join(", ") || "–";
}

/** Collapse whitespace for a table cell. */
function flatten(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** {@link markdownTable} without its trailing newline (sections are joined with blank lines). */
function markdownTableTrimmed(
    headers: readonly string[],
    rows: readonly (readonly string[])[],
): string {
    return markdownTable(headers, rows).trimEnd();
}
