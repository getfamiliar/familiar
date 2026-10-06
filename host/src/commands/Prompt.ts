import { spawn } from "node:child_process";
import {
    CORE_PROMPT_PLACEHOLDERS,
    markdownTable,
    PROMPT_TEMPLATE_FILE,
    type PromptPlaceholderKind,
    writeMarkdown,
} from "@getfamiliar/shared";
import { defineCommand } from "citty";
import { AGENT_CONTAINER_NAME } from "../container-bridge/AgentContainer.js";
import type { PluginHost } from "../plugins/PluginHost.js";
import { isContainerRunning } from "../utils/DockerTools.js";

const RAW_ARG = {
    type: "boolean",
    description: "Skip terminal styling and emit the raw markdown verbatim.",
    default: false,
} as const;

/** Characters of a placeholder value shown in the dry-run table. */
const VALUE_EXCERPT_CHARS = 80;

/** Container-side dry-run entry, relative to the agent image's `/app`. */
const DRY_RUN_SCRIPT = "src/prompt/PromptDryRun.ts";

/** One row of the placeholder overview. */
interface PlaceholderRow {
    readonly name: string;
    /** `core` or the registering plugin's id. */
    readonly source: string;
    readonly kind: PromptPlaceholderKind;
    readonly description: string;
}

/** Mirror of the container's `DryRunOutput` JSON document. */
interface DryRunOutput {
    readonly handlerPath: string;
    readonly templatePath: string | null;
    readonly toolNames: readonly string[];
    readonly placeholders: readonly {
        readonly name: string;
        readonly value: string | null;
        readonly isUsed: boolean;
        readonly isBeforeMarker: boolean;
    }[];
    readonly appenderSections: readonly { readonly pluginId: string; readonly text: string }[];
    readonly warnings: readonly string[];
    readonly system: string;
    readonly userHead: string;
}

/**
 * Build the `familiar prompt` command group.
 *
 * @param pluginHost Plugin host, for plugin-registered placeholders.
 * @returns The citty command.
 */
export function buildPromptCommand(pluginHost: PluginHost) {
    return defineCommand({
        meta: {
            name: "prompt",
            description: "Inspect prompt templates: list placeholders, dry-run a handler's prompt.",
        },
        subCommands: {
            placeholders: placeholdersCommand(pluginHost),
            "dry-run": dryRunCommand(pluginHost),
        },
    });
}

/**
 * `familiar prompt placeholders` — table of every placeholder a template
 * may use. Works without the daemon: core definitions come from
 * `@getfamiliar/shared`, plugin ones from the plugins' `prepare()`.
 */
function placeholdersCommand(pluginHost: PluginHost) {
    return defineCommand({
        meta: {
            name: "placeholders",
            description: "List every placeholder prompt templates can use.",
        },
        args: { raw: RAW_ARG },
        run({ args }) {
            const rows = listPlaceholderRows(pluginHost);
            const table = markdownTable(
                ["Placeholder", "Source", "Kind", "Description"],
                rows.map((row) => [`{${row.name}}`, row.source, row.kind, row.description]),
            );
            const markdown = [
                "# Prompt placeholders",
                "",
                table.trimEnd(),
                "",
                `Besides these, \`{path.md}\` includes a workspace-relative markdown file (e.g. \`{SOUL.md}\`). Handlers use \`${PROMPT_TEMPLATE_FILE}\` unless their \`systemPrompt\` frontmatter says \`none\` or names another template. \`dynamic\` placeholders change per run and belong after \`{CACHE_MARKER}\`.`,
            ].join("\n");
            writeMarkdown(markdown, { raw: args.raw === true });
        },
    });
}

/**
 * `familiar prompt dry-run <topic>` — render a handler's prompt inside
 * the running agent container without starting a run.
 */
function dryRunCommand(pluginHost: PluginHost) {
    return defineCommand({
        meta: {
            name: "dry-run",
            description:
                "Render a handler's prompt in the running agent container without starting a run.",
        },
        args: {
            topic: {
                type: "positional",
                required: true,
                description: "Event topic, e.g. chat:telegram",
            },
            handler: {
                type: "string",
                description: "Handler basename (default: index).",
                default: "index",
            },
            privileged: {
                type: "boolean",
                description: "Render as a privileged run.",
                default: false,
            },
            prompt: {
                type: "string",
                description: "Seed prompt handed to plugin placeholders and appenders.",
            },
            full: {
                type: "boolean",
                description: "Also print the complete system prompt and user-message head.",
                default: false,
            },
            raw: RAW_ARG,
        },
        async run({ args }) {
            if (!(await isContainerRunning(AGENT_CONTAINER_NAME))) {
                throw new Error(
                    `${AGENT_CONTAINER_NAME} is not running — start the daemon first (\`familiar start\`), or use \`familiar prompt placeholders\` for the definitions`,
                );
            }
            const input = {
                topic: String(args.topic),
                handler: String(args.handler),
                prompt: typeof args.prompt === "string" ? args.prompt : null,
                privileged: args.privileged === true,
            };
            const output = await runDryRunInContainer(input);
            const markdown = renderDryRun(
                output,
                input,
                listPlaceholderRows(pluginHost),
                args.full === true,
            );
            writeMarkdown(markdown, { raw: args.raw === true });
        },
    });
}

/**
 * Core placeholders followed by plugin-registered ones.
 *
 * @param pluginHost Plugin host; its plugins are prepared on demand.
 * @returns One row per placeholder.
 */
function listPlaceholderRows(pluginHost: PluginHost): PlaceholderRow[] {
    pluginHost.prepareAll();
    const core = CORE_PROMPT_PLACEHOLDERS.map((definition) => ({
        ...definition,
        source: "core",
    }));
    const plugin = pluginHost.promptPlaceholders.list().map((registration) => ({
        name: registration.name,
        source: registration.pluginId,
        kind: "dynamic" as const,
        description: registration.description,
    }));
    return [...core, ...plugin];
}

/**
 * Run the container-side dry run via `docker exec` and parse its JSON.
 *
 * @param input Topic, handler, seed prompt and privilege flag.
 * @returns The parsed report.
 * @throws When the container script fails or prints malformed JSON.
 */
function runDryRunInContainer(input: object): Promise<DryRunOutput> {
    const dockerArgs = [
        "exec",
        "-w",
        "/app",
        AGENT_CONTAINER_NAME,
        "gosu",
        "priv:familiar",
        "node_modules/.bin/tsx",
        DRY_RUN_SCRIPT,
        JSON.stringify(input),
    ];
    return new Promise((resolve, reject) => {
        const proc = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        proc.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        proc.on("error", reject);
        proc.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`prompt dry run failed (exit ${code}): ${stderr.trim()}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout) as DryRunOutput);
            } catch (err) {
                reject(
                    new Error(
                        `prompt dry run printed malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
                    ),
                );
            }
        });
    });
}

/**
 * Render the dry-run report as markdown.
 *
 * @param output Container report.
 * @param input The dry-run input, echoed in the header.
 * @param rows Known placeholder definitions (core + plugin).
 * @param isFull Whether to append the complete rendered prompt.
 * @returns Markdown for {@link writeMarkdown}.
 */
function renderDryRun(
    output: DryRunOutput,
    input: { topic: string; privileged: boolean },
    rows: readonly PlaceholderRow[],
    isFull: boolean,
): string {
    const byName = new Map(output.placeholders.map((p) => [p.name, p]));
    const known = new Set(rows.map((row) => row.name));
    const tableRows = rows.map((row) => {
        const resolved = byName.get(row.name);
        return [
            `{${row.name}}`,
            row.source,
            row.kind,
            formatUsage(resolved),
            excerpt(resolved?.value ?? null, row.name),
        ];
    });
    for (const unknown of output.placeholders.filter((p) => !known.has(p.name))) {
        tableRows.push([`{${unknown.name}}`, "unknown", "—", formatUsage(unknown), "—"]);
    }

    const lines = [
        `# Prompt dry run: ${output.handlerPath}`,
        "",
        `- Template: ${output.templatePath === null ? "none (handler body only)" : `\`${output.templatePath}\``}`,
        `- Topic: \`${input.topic}\`, privileged: ${input.privileged ? "yes" : "no"}`,
        `- Preloaded tools: ${output.toolNames.length}`,
        `- System prompt: ${output.system.length} chars, user-message head: ${output.userHead.length} chars`,
        "",
        "## Placeholders",
        "",
        markdownTable(["Placeholder", "Source", "Kind", "Used", "Value"], tableRows),
        "",
        "## Plugin appenders",
        "",
        output.appenderSections.length === 0
            ? "(none)"
            : output.appenderSections
                  .map((s) => `- \`${s.pluginId}\`: ${s.text.length} chars`)
                  .join("\n"),
        "",
        "## Warnings",
        "",
        output.warnings.length === 0 ? "(none)" : output.warnings.map((w) => `- ${w}`).join("\n"),
    ];
    if (isFull) {
        lines.push(
            "",
            "## System prompt",
            "",
            fenced(output.system),
            "",
            "## User-message head",
            "",
            fenced(output.userHead),
        );
    }
    return lines.join("\n");
}

/** Describe where a placeholder is used. */
function formatUsage(resolved: DryRunOutput["placeholders"][number] | undefined): string {
    if (resolved === undefined || !resolved.isUsed) {
        return "no";
    }
    return resolved.isBeforeMarker ? "system prompt" : "user message";
}

/**
 * One-line excerpt of a value for the table.
 *
 * @param value Resolved value, or `null`.
 * @param name Placeholder name, for structural placeholders.
 * @returns The excerpt.
 */
function excerpt(value: string | null, name: string): string {
    if (name === "CACHE_MARKER") {
        return "(split point)";
    }
    if (name === "HANDLER_CONTENT") {
        return "(handler body)";
    }
    if (value === null) {
        return "—";
    }
    const oneLine = value.replace(/\s*\n\s*/g, " ⏎ ");
    return oneLine.length > VALUE_EXCERPT_CHARS
        ? `${oneLine.slice(0, VALUE_EXCERPT_CHARS)}…`
        : oneLine;
}

/**
 * Wrap text in a markdown code fence longer than any backtick run inside it.
 *
 * @param text The text.
 * @returns The fenced block.
 */
function fenced(text: string): string {
    const longestRun = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longestRun + 1);
    return `${fence}markdown\n${text}\n${fence}`;
}
