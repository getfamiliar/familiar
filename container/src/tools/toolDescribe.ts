import { promises as fs } from "node:fs";
import path from "node:path";
import {
    DEFAULT_TOOL_LEVEL,
    runTextTool,
    ToolError,
    type ToolLevel,
    type ToolRunContext,
} from "@getfamiliar/shared";
import { asSchema, jsonSchema, type Tool, type ToolSet, tool } from "ai";
import { HandlerFile } from "../HandlerFile.js";
import { unknownToolMessage } from "./toolCall.js";

interface ToolDescribeInput {
    readonly name: string;
}

/** A skill whose markdown mentions the described tool. */
interface SkillMention {
    /** Skill folder name under `skills/` (the skill id). */
    readonly id: string;
    /** Workspace-relative path to the skill's entry-point `SKILL.md`. */
    readonly path: string;
}

/** Guidance line prefacing the skills that mention the described tool. */
const SKILLS_MENTION_PREAMBLE =
    "The tool is mentioned in the following skills, consider reading them for " +
    "instance-specific usage details:";

/**
 * Build the `tool_describe` detail tool. Sits between `tool_list`
 * (discover names, truncated descriptions, no schema) and `tool_call`
 * (invoke by name): given an exact tool key, it returns the tool's
 * **full, untruncated** description, its **raw input JSON Schema**, and
 * any workspace skills that mention the tool.
 *
 * The result is a **mixed** document — prose for the human-readable
 * parts (description, skills note), the schema kept verbatim in a fenced
 * ```json block. Nothing *parses* this output: a model reads it and then
 * emits a `tool_call`, so the objective is pure model readability. Prose
 * keeps markdown-laden descriptions from being escaped into noise;
 * keeping the schema verbatim is lossless (enums / nested objects /
 * arrays / defaults all survive) and needs no schema→prose renderer; the
 * JSON Schema is also the model's native tool-definition format, so it is
 * exactly what a weaker tool-caller was tuned to turn into a conforming
 * `arguments` object.
 *
 * Reads the **unwrapped** pool so the description is the full one (the
 * wrapper clamps descriptions) and `inputSchema` is present.
 *
 * @param pool The unwrapped tool pool (built-ins ∪ MCP ∪ plugin tools).
 * @param levelsByKey Per-key security level, for the header line.
 * @param loaded Keys already in the agent's toolset (callable directly).
 * @param ctx Per-call run context for oversized-output offloading.
 */
export function buildToolDescribeTool(
    pool: ToolSet,
    levelsByKey: ReadonlyMap<string, ToolLevel>,
    loaded: ReadonlySet<string>,
    ctx: ToolRunContext,
): Tool<ToolDescribeInput, string> {
    return tool<ToolDescribeInput, string>({
        description:
            "Get a tool's full detail before calling it: its complete (untruncated) " +
            "description, its raw input JSON Schema, and any skills that mention it. " +
            "Discover names with `tool_list`, inspect the exact argument shape here, then " +
            "invoke with `tool_call` (or directly when it's already loaded). Pass {name}, " +
            "the exact tool key. The fenced JSON block under `Input parameters` is the " +
            "schema your `tool_call` {arguments} must satisfy.",
        inputSchema: jsonSchema<ToolDescribeInput>({
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
                name: {
                    type: "string",
                    description: "Exact tool key to describe (as shown by `tool_list`).",
                },
            },
        }),
        execute: ({ name }) =>
            runTextTool(async () => {
                const target = pool[name];
                if (target === undefined) {
                    throw new ToolError("UnknownTool", unknownToolMessage(name, pool));
                }

                const level = levelsByKey.get(name) ?? DEFAULT_TOOL_LEVEL;
                const loadedNote = loaded.has(name)
                    ? "loaded — callable directly"
                    : "not loaded — invoke via `tool_call`";
                const description = (target.description ?? "").trim();
                const schemaBlock = await renderSchemaBlock(target);
                const skills = await findSkillsMentioning(name);

                const sections: string[] = [
                    `# ${name}\n\nLevel: ${level} · ${loadedNote}`,
                    description.length > 0 ? description : "_(no description provided)_",
                    `## Input parameters\n\n${schemaBlock}`,
                ];
                if (skills.length > 0) {
                    const bullets = skills.map((skill) => `- \`${skill.path}\``).join("\n");
                    sections.push(`${SKILLS_MENTION_PREAMBLE}\n\n${bullets}`);
                }
                return sections.join("\n\n");
            }, ctx),
    });
}

/**
 * Render a tool's input schema as a fenced ```json block. The schema is
 * read the same way the factory sizes tool definitions
 * (`asSchema(...).jsonSchema`). A read failure degrades to a short note
 * rather than faulting the whole describe call.
 *
 * @param target The tool whose `inputSchema` to render.
 * @returns A fenced JSON code block, or a `_(schema unavailable)_` note.
 */
async function renderSchemaBlock(target: Tool): Promise<string> {
    try {
        const schema = await Promise.resolve(asSchema(target.inputSchema).jsonSchema);
        return `\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``;
    } catch {
        return "_(schema unavailable)_";
    }
}

/**
 * Find every skill whose markdown mentions `toolName`. Scans **all**
 * `.md` files under the skills tree (`skills/**\/*.md`) — not just
 * `SKILL.md`, since a skill can ship examples / templates — via Node's
 * `fs.glob`, the same idiom `buildGlobTool` uses. A case-insensitive
 * substring hit in any file maps back to the owning skill (the first
 * path segment under `skills/`); results dedupe to one entry per skill,
 * pointing at that skill's `SKILL.md` entry point.
 *
 * @param toolName Exact tool key to search for.
 * @returns Matching skills, sorted by id; `[]` when `skills/` is absent.
 */
async function findSkillsMentioning(toolName: string): Promise<SkillMention[]> {
    const root = HandlerFile.getWorkspaceRoot();
    const needle = toolName.toLowerCase();
    const ids = new Set<string>();
    try {
        for await (const rel of fs.glob("skills/**/*.md", { cwd: root })) {
            const id = rel.split(/[/\\]/)[1];
            if (id === undefined || id.length === 0 || ids.has(id)) {
                // Missing id, or the skill already matched an earlier file.
                continue;
            }
            let content: string;
            try {
                content = await fs.readFile(path.join(root, rel), "utf8");
            } catch {
                continue;
            }
            if (content.toLowerCase().includes(needle)) {
                ids.add(id);
            }
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
        }
        throw err;
    }
    return [...ids]
        .sort((a, b) => a.localeCompare(b))
        .map((id) => ({ id, path: `skills/${id}/SKILL.md` }));
}
