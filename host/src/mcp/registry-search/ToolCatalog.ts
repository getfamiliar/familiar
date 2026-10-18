import { sanitizeExternalText } from "../../utils/ExternalTextSanitizer.js";
import { fetchJson, isMapping, optionalString } from "./RegistryHttp.js";

/** One tool a server publishes, texts sanitized. */
export interface PublishedTool {
    readonly name: string;
    readonly description: string;
    readonly parameters: readonly {
        readonly name: string;
        readonly type: string;
        readonly description: string;
    }[];
    /** MCP tool annotations; absent when the publisher didn't declare them. */
    readonly readOnly?: boolean;
    readonly destructive?: boolean;
}

/**
 * Load the per-server tool list the Docker catalog publishes
 * (`toolsUrl`, e.g. `https://desktop.docker.com/mcp/catalog/v3/tools/notion.json`).
 *
 * @param toolsUrl The list URL.
 * @returns The tools.
 * @throws Error when the list can't be fetched or isn't a list.
 */
export async function fetchCatalogTools(toolsUrl: string): Promise<PublishedTool[]> {
    const body = await fetchJson(toolsUrl);
    if (!Array.isArray(body)) {
        throw new Error(`${toolsUrl}: tool list is not an array`);
    }
    const tools: PublishedTool[] = [];
    for (const raw of body) {
        const name = isMapping(raw) ? optionalString(raw.name) : undefined;
        if (name === undefined || !isMapping(raw)) {
            continue;
        }
        const annotations = isMapping(raw.annotations) ? raw.annotations : {};
        tools.push({
            name: sanitizeExternalText(name),
            description: sanitizeExternalText(optionalString(raw.description) ?? ""),
            parameters: (Array.isArray(raw.arguments) ? raw.arguments : [])
                .filter(isMapping)
                .filter((arg) => typeof arg.name === "string")
                .map((arg) => ({
                    name: sanitizeExternalText(arg.name as string),
                    type: sanitizeExternalText(optionalString(arg.type) ?? "any"),
                    description: sanitizeExternalText(
                        optionalString(arg.desc) ?? optionalString(arg.description) ?? "",
                    ),
                })),
            readOnly:
                typeof annotations.readOnlyHint === "boolean"
                    ? annotations.readOnlyHint
                    : undefined,
            destructive:
                typeof annotations.destructiveHint === "boolean"
                    ? annotations.destructiveHint
                    : undefined,
        });
    }
    return tools;
}
