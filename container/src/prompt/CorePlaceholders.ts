import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CACHE_MARKER_PLACEHOLDER, CORE_PROMPT_PLACEHOLDERS } from "@getfamiliar/shared";
import { parse as parseYaml } from "yaml";
import { HandlerFile } from "../HandlerFile.js";
import { PassedConfig, resolveTimezone } from "../utils/PassedConfig.js";

/**
 * Absolute path of the per-container scratch root. Bind-mounted to the
 * host's `tmp/scratch/` and to every MCP container at the same
 * absolute path, so `/scratch/<event-id>/<name>` is the one path string
 * the agent uses for both `fs_read` and MCP tool arguments.
 */
const SCRATCH_ROOT = "/scratch";

/**
 * Maximum characters preserved on a skill description in `{SKILL_LIST}`.
 * Anything beyond is cut and marked with a single `…` so the agent sees
 * the value was clipped.
 */
const MAX_SKILL_DESCRIPTION_CHARS = 256;

/** Rendered for list placeholders that have nothing to list. */
const EMPTY_LIST = "(none)";

/**
 * Core placeholders the template engine expands structurally instead
 * of through a resolver: the marker splits the template, and
 * `HANDLER_CONTENT` is workspace markdown that is itself parsed as
 * template.
 */
export const STRUCTURAL_PLACEHOLDERS: ReadonlySet<string> = new Set([
    CACHE_MARKER_PLACEHOLDER,
    "HANDLER_CONTENT",
]);

/**
 * Per-run inputs the core resolvers read. Deliberately minimal — add a
 * field only when a placeholder genuinely needs it.
 */
export interface CorePlaceholderContext {
    /** The resolved handler file driving this agentrun. */
    readonly handler: HandlerFile;
    /** The event topic this agentrun is processing (e.g. `chat:telegram`). */
    readonly topic: string;
    /** Whether the run descends from a trusted user-input source. */
    readonly privileged: boolean;
    /** Ids of the tools preloaded for this run. */
    readonly toolNames: readonly string[];
    /** Event id; locates the staged files under `/scratch/<eventId>/`. */
    readonly eventId: string;
    /** Wall-clock instant the prompt is assembled at. */
    readonly now: Date;
}

/** Produces one placeholder's value for a run. */
export type CorePlaceholderResolver = (ctx: CorePlaceholderContext) => string;

/**
 * Value resolvers for every non-structural core placeholder, keyed by
 * name. An explicit static table (mirroring `CONTAINER_TOOL_GROUPS`) so
 * the full set is visible in one place; names and descriptions live in
 * `CORE_PROMPT_PLACEHOLDERS` in `@getfamiliar/shared`.
 */
export const CORE_PLACEHOLDER_RESOLVERS: Readonly<Record<string, CorePlaceholderResolver>> = {
    HANDLER_PATH: (ctx) => ctx.handler.relativePath,
    HANDLER_INHERITS: (ctx) => formatInheritance(ctx.handler),
    SKILL_LIST: () => listSkills() ?? EMPTY_LIST,
    TOOL_LIST: (ctx) => formatBullets(ctx.toolNames),
    PYTHON_PACKAGE_LIST: () =>
        formatCommaList(PassedConfig.get<string[]>("python.packages") ?? [], false),
    WRITABLE_PATH_LIST: () =>
        formatCommaList(PassedConfig.get<string[]>("core.writablePaths") ?? [], true),
    RUNTIME_LIST: (ctx) => formatRuntimeList(ctx),
    CURRENT_TIME: (ctx) => formatRuntimeTime(ctx.now, resolveTimezone()),
    EVENT_TOPIC: (ctx) => ctx.topic,
    PRIVILEGED: (ctx) => (ctx.privileged ? "yes" : "no"),
    STAGED_FILE_LIST: (ctx) => listStagedFiles(ctx.eventId) ?? EMPTY_LIST,
};

/**
 * Whether the container core owns a placeholder name (structurally or
 * through a resolver).
 *
 * @param name Placeholder name without braces.
 * @returns `true` for core names.
 */
export function isContainerCorePlaceholder(name: string): boolean {
    return STRUCTURAL_PLACEHOLDERS.has(name) || CORE_PLACEHOLDER_RESOLVERS[name] !== undefined;
}

/**
 * Whether a core placeholder changes from run to run, per its shared
 * definition.
 *
 * @param name Placeholder name without braces.
 * @returns `true` for core placeholders of kind `dynamic`.
 */
export function isDynamicCorePlaceholder(name: string): boolean {
    return CORE_PROMPT_PLACEHOLDERS.some(
        (definition) => definition.name === name && definition.kind === "dynamic",
    );
}

/**
 * Render `items` as a markdown bullet list.
 *
 * @param items The entries.
 * @returns One `- item` line per entry, or `(none)`.
 */
function formatBullets(items: readonly string[]): string {
    return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : EMPTY_LIST;
}

/**
 * Render `items` comma-separated.
 *
 * @param items The entries.
 * @param isCode Wrap every entry in backticks.
 * @returns The list, or `(none)`.
 */
function formatCommaList(items: readonly string[], isCode: boolean): string {
    if (items.length === 0) {
        return EMPTY_LIST;
    }
    return items.map((item) => (isCode ? `\`${item}\`` : item)).join(", ");
}

/**
 * Render the handler's parent chain as `` `a` ← `b` ``.
 *
 * @param handler The resolved handler.
 * @returns The chain, or `(none)` for an unmerged handler.
 */
function formatInheritance(handler: HandlerFile): string {
    if (handler.inheritsFrom.length === 0) {
        return EMPTY_LIST;
    }
    return handler.inheritsFrom.map((p) => `\`${p}\``).join(" ← ");
}

/**
 * Build the bullet list of per-run facts: wall-clock time, event topic,
 * handler file (with the parents it inherits from, when merged), whether
 * the final reply is mirrored into the chat (`outputChat`), and the
 * privilege flag.
 *
 * @param ctx The run context.
 * @returns The bullet list.
 */
function formatRuntimeList(ctx: CorePlaceholderContext): string {
    const lines = [
        `- Current time: ${formatRuntimeTime(ctx.now, resolveTimezone())}`,
        `- Event topic: \`${ctx.topic}\``,
        `- Handler file: \`${ctx.handler.relativePath}\``,
    ];
    if (ctx.handler.inheritsFrom.length > 0) {
        lines.push(`- Inheriting from: ${formatInheritance(ctx.handler)}`);
    }
    lines.push(`- outputChat: ${ctx.handler.header.outputChat === true ? "true" : "false"}`);
    // Privileged runs descend from a trusted user-input source (the
    // operator at the local terminal or on Telegram). Tools that gate
    // risky reads / writes on this flag refuse non-privileged calls, so
    // the agent should know up front whether they're available.
    lines.push(
        `- privileged: ${ctx.privileged ? "yes, the prompt stems from the system owner" : "no"}`,
    );
    return lines.join("\n");
}

/**
 * List the files staged at `/scratch/<eventId>/` as bullets with their
 * byte size. Files are listed in name order for stability across runs;
 * hidden dotfiles are skipped — same convention as `WorkspaceWatcher`.
 *
 * @param eventId The event whose scratch folder to list.
 * @returns The bullet list, or `null` when the folder is missing or empty.
 * @throws On I/O errors other than a missing folder.
 */
export function listStagedFiles(eventId: string): string | null {
    if (eventId.length === 0) {
        return null;
    }
    const dir = path.join(SCRATCH_ROOT, eventId);
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw err;
    }
    const lines: string[] = [];
    for (const name of entries.sort()) {
        if (name.startsWith(".")) {
            continue;
        }
        const full = path.join(dir, name);
        let stat: ReturnType<typeof statSync>;
        try {
            stat = statSync(full);
        } catch {
            continue;
        }
        if (!stat.isFile()) {
            continue;
        }
        lines.push(`- \`${full}\` (${stat.size} bytes)`);
    }
    return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Scan `<workspaceRoot>/skills/` and render one bullet per skill:
 * `` - `id`: description ``.
 *
 * A skill is `skills/<id>/SKILL.md` with at least a `description` in its
 * YAML frontmatter. Entries that don't match this shape (loose files,
 * folders without SKILL.md, malformed YAML, missing description) are
 * skipped — the catalog is best-effort, not a validation surface. Skills
 * are pure context the agent reads with `fs_read` and follows.
 *
 * @returns The bullets sorted by id, or `null` when there are no valid skills.
 * @throws On I/O errors other than a missing `skills/` folder.
 */
export function listSkills(): string | null {
    const skillsRoot = path.join(HandlerFile.getWorkspaceRoot(), "skills");

    let entries: string[];
    try {
        entries = readdirSync(skillsRoot);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw err;
    }

    const bullets: { id: string; line: string }[] = [];
    for (const id of entries) {
        const skillDir = path.join(skillsRoot, id);
        let stat: ReturnType<typeof statSync>;
        try {
            stat = statSync(skillDir);
        } catch {
            continue;
        }
        if (!stat.isDirectory()) {
            continue;
        }
        let raw: string;
        try {
            raw = readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
        } catch {
            continue;
        }
        const frontmatter = parseSkillFrontmatter(raw);
        const description = frontmatter?.description;
        if (typeof description !== "string" || description.trim().length === 0) {
            continue;
        }
        const trimmedDescription = description.trim();
        const cappedDescription =
            trimmedDescription.length > MAX_SKILL_DESCRIPTION_CHARS
                ? `${trimmedDescription.slice(0, MAX_SKILL_DESCRIPTION_CHARS)}…`
                : trimmedDescription;
        bullets.push({ id, line: `- \`${id}\`: ${cappedDescription}` });
    }

    if (bullets.length === 0) {
        return null;
    }
    bullets.sort((a, b) => a.id.localeCompare(b.id));
    return bullets.map((b) => b.line).join("\n");
}

/**
 * Parse the YAML frontmatter block out of a SKILL.md source string.
 * Intentionally separate from {@link HandlerFile}'s typed header
 * validation; the regex is the same shape.
 *
 * @param source The SKILL.md text.
 * @returns The parsed mapping, or `null` when absent, malformed or not a mapping.
 */
function parseSkillFrontmatter(source: string): Record<string, unknown> | null {
    const match = source.trim().match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n?([\s\S]*)$/);
    if (!match) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = parseYaml(match[1] ?? "");
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
    }
    return parsed as Record<string, unknown>;
}

/**
 * Format a `Date` for the runtime facts:
 * `Friday, 2026-05-19T18:43:12 in timezone Europe/Berlin`.
 *
 * Weekday name + ISO-like local time + the IANA tz label, all relative
 * to `timezone`. Built from `Intl.DateTimeFormat.formatToParts` so we
 * control the separators directly — the locale-default formatter
 * inserts AM/PM and locale punctuation we don't want.
 *
 * @param date The instant to format.
 * @param timezone IANA timezone.
 * @returns The formatted string.
 */
export function formatRuntimeTime(date: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "long",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(date);
    const lookup = new Map(parts.map((p) => [p.type, p.value]));
    const weekday = lookup.get("weekday") ?? "";
    const year = lookup.get("year") ?? "";
    const month = lookup.get("month") ?? "";
    const day = lookup.get("day") ?? "";
    // `hour: '2-digit'` with `hour12: false` can yield "24" at midnight
    // on some implementations; normalise to "00".
    const rawHour = lookup.get("hour") ?? "";
    const hour = rawHour === "24" ? "00" : rawHour;
    const minute = lookup.get("minute") ?? "";
    const second = lookup.get("second") ?? "";
    return `${weekday}, ${year}-${month}-${day}T${hour}:${minute}:${second} in timezone ${timezone}`;
}
