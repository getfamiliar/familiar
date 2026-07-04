import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { HandlerFile } from "./HandlerFile.js";
import {
    CONTAINER_PROMPT_CONTRIBUTORS,
    type PromptContributor,
    type PromptContributorContext,
} from "./prompt-contributors.js";
import { resolveTimezone } from "./utils/PassedConfig.js";

/**
 * Absolute path of the per-container scratch root. Bind-mounted to the
 * host's `tmp/scratch/` and to every MCP container at the same
 * absolute path, so `/scratch/<event-id>/<name>` is the one path string
 * the agent uses for both `fs_read` and MCP tool arguments.
 */
const SCRATCH_ROOT = "/scratch";

/**
 * Hard cap on the character length of each individually-included
 * section (a workspace file, the handler body, the run prompt).
 * Per-section truncation happens before assembly.
 */
const MAX_FILE_CHARS = 8000;

/**
 * Hard cap on the assembled system prompt. Functions as a safety net
 * after per-section truncation; if the assembled total still exceeds
 * this, the trailing portion is cut off. With several ~8000-char
 * sections the cap leaves headroom for section framing.
 */
const MAX_SYSTEM_CHARS = 32000;

/** Hard cap on the assembled user prompt. */
const MAX_PROMPT_CHARS = 16000;

/**
 * Maximum characters preserved on a skill description when rendering
 * the `# Available skills` section. Anything beyond is cut and marked
 * with a single `…` so the agent sees the value was clipped.
 */
const MAX_SKILL_DESCRIPTION_CHARS = 256;

/**
 * Maximum characters preserved on a single key in a payload object.
 * Keys are sanitized to printable ASCII first; anything beyond this
 * cap is dropped. Long keys are almost always a sign that an event
 * source is dumping internal state into a key name; trimming keeps
 * the rendered payload readable for the model.
 */
const MAX_KEY_CHARS = 64;

/**
 * Maximum characters preserved on a single string value before
 * truncation. Per-field cap so one giant blob (a long body, a base64
 * attachment) doesn't squeeze the rest of the payload out of the
 * prompt budget.
 */
const MAX_VALUE_CHARS = 4000;

/**
 * Maximum characters of the rendered (post-sanitization, post-per-
 * field-truncation) payload string included in the user prompt.
 * Acts as a final safety net after the per-key/per-value caps; an
 * exceedingly large payload still gets cut off cleanly.
 */
const MAX_PAYLOAD_CHARS = 5000;

/**
 * Compose the system prompt the {@link AgentRunner} hands to its
 * {@link import("ai").ToolLoopAgent}.
 *
 * SOUL.md and CONTEXT.md are read from the workspace root (using
 * {@link HandlerFile.getWorkspaceRoot}); missing files are skipped
 * without erroring. Per-section truncation is enforced as content is
 * gathered; an overall cap is applied after assembly as a safety net.
 * Truncated values get a `…[truncated, original N chars]` marker so the
 * model knows the value is incomplete.
 *
 * The handler's `systemPrompt` frontmatter chooses which of those
 * framing files are included:
 *
 * - `full` (default) — SOUL + CONTEXT.
 * - `only-soul` — SOUL only.
 * - `none` — none of them.
 *
 * The handler body and the tool list are always included regardless of
 * mode.
 *
 * The prompt is intentionally **static per handler**: the per-run
 * dynamic sections (`# Runtime`, plugin-contributed event context) live
 * in the current-run user message instead — see
 * {@link buildRuntimeContextBlock}. Keeping the system prompt stable is
 * what makes it a cacheable prefix for providers like Anthropic.
 *
 * Returns both the verbatim prompt (`full`, what inference sees) and a
 * `redacted` variant where the framing-file sections have their file
 * body swapped for a `<content of file …>` placeholder. The
 * caller chooses which one to persist onto `agentruns.system_prompt`
 * based on `core.logSystemPrompt`; the variant fed to the model is
 * always `full`. When the handler's mode excludes the framing files,
 * `full === redacted`.
 *
 * @param handler The resolved handler file. Body becomes the `# Handler`
 *   section. `header.systemPrompt` selects the framing mode.
 * @param toolNames Ids of tools the agent is permitted to call for
 *   this run. Listed under "Available tools"; an empty array produces
 *   "(none)".
 */
export function buildSystemPrompt(
    handler: HandlerFile,
    toolNames: readonly string[],
): BuiltSystemPrompt {
    const sections: SystemPromptSection[] = [];
    const mode = handler.header.systemPrompt ?? "full";

    if (mode === "full" || mode === "only-soul") {
        const soul = readWorkspaceFile("SOUL.md");
        if (soul !== null) {
            sections.push(framingFileSection("Identity", "SOUL.md", soul));
        }
    }

    if (mode === "full") {
        const context = readWorkspaceFile("CONTEXT.md");
        if (context !== null) {
            sections.push(framingFileSection("Context", "CONTEXT.md", context));
        }
    }

    if (handler.body.trim().length > 0) {
        sections.push(verbatim(`# Handler\n\n${truncate(handler.body, MAX_FILE_CHARS)}`));
    }

    const skillsSection = buildAvailableSkillsSection();
    if (skillsSection !== null) {
        sections.push(verbatim(skillsSection));
    }

    const toolList =
        toolNames.length > 0 ? toolNames.map((name) => `- ${name}`).join("\n") : "(none)";
    sections.push(verbatim(`# Available tools\n\n${toolList}`));

    return {
        full: truncate(sections.map((s) => s.full).join("\n\n"), MAX_SYSTEM_CHARS),
        redacted: truncate(sections.map((s) => s.redacted).join("\n\n"), MAX_SYSTEM_CHARS),
    };
}

/**
 * Compose the per-run **dynamic** context block that prepends to the
 * current-run user message. Sections, in order:
 *
 * 1. `# Runtime` — wall-clock time, topic, handler path, `privileged`.
 * 2. Container-core contributor sections (e.g. the `## The bash tool`
 *    help) — these see the resolved `toolNames` and `privileged`, which
 *    the host can't supply to its own providers.
 * 3. Host-plugin event-context sections fetched from the bastion (e.g.
 *    injected memories).
 *
 * This content used to live at the tail of the system prompt. It moved
 * out so the system prompt can stay byte-stable per handler (a cacheable
 * prefix); the dynamic, per-run bits ride in the user turn instead,
 * where they don't invalidate the cached prefix. For a single-shot
 * non-chat handler this block leads the first and only user message; in
 * multi-turn chat it leads the trailing user turn, after the cacheable
 * prior history.
 *
 * @param handler The resolved handler file; path / inheritance /
 *   `outputChat` feed the `# Runtime` section.
 * @param topic The event topic this agentrun is processing (e.g.
 *   `chat:telegram`). Surfaced in `# Runtime` so the agent can reason
 *   about which channel/source produced the event.
 * @param privileged Whether the agentrun descends from a trusted
 *   user-input source. Surfaced in `# Runtime` so the agent knows which
 *   trust-gated tools are available to it.
 * @param toolNames Ids of the tools the agent may call for this run
 *   (post-filter). Passed to the container-core contributors so a tool
 *   can contribute help only when it is actually available.
 * @param eventContext Identifiers needed to fetch plugin-contributed
 *   event-context sections from the bastion's `/event-context/`
 *   gateway. Pass `null` to skip the fetch entirely — used by tests and
 *   one-off harnesses that don't have a live bastion.
 * @param contributors The container-core contributors to run. Defaults
 *   to {@link CONTAINER_PROMPT_CONTRIBUTORS}; injectable so tests can
 *   pass stubs or an empty list.
 * @returns The assembled dynamic block. Always contains at least the
 *   `# Runtime` section, so it is never empty.
 */
export async function buildRuntimeContextBlock(
    handler: HandlerFile,
    topic: string,
    privileged: boolean,
    toolNames: readonly string[],
    eventContext: EventContextFetchInput | null,
    contributors: readonly PromptContributor[] = CONTAINER_PROMPT_CONTRIBUTORS,
): Promise<string> {
    const sections: string[] = [`# Runtime\n\n${buildRuntimeSection(handler, topic, privileged)}`];

    // Container-core contributors run after `# Runtime`: they see the
    // resolved toolNames + privileged, which host plugins can't.
    const contributorCtx: PromptContributorContext = { handler, topic, toolNames, privileged };
    for (const contribute of contributors) {
        const text = contribute(contributorCtx);
        if (text !== null && text.trim().length > 0) {
            sections.push(text.trim());
        }
    }

    // Host-plugin event-context sections last.
    if (eventContext !== null) {
        const eventContextSections = await fetchEventContextSections(eventContext);
        for (const section of eventContextSections) {
            sections.push(section.text.trim());
        }
    }

    return sections.join("\n\n");
}

/**
 * One assembled section of the system prompt, in two parallel
 * variants:
 *
 * - `full` is what the agent receives at inference time (the same
 *   string that used to be the only output of {@link buildSystemPrompt}).
 * - `redacted` is what gets persisted onto `agentruns.system_prompt`
 *   when the operator has selected `core.logSystemPrompt: "non-static"`.
 *   For the workspace-root framing files (SOUL.md / CONTEXT.md) the file
 *   body is replaced with a single-line `<content of file …>`
 *   placeholder; for every other section the two variants are identical.
 */
interface SystemPromptSection {
    readonly full: string;
    readonly redacted: string;
}

/** Both variants of the assembled prompt; see {@link SystemPromptSection}. */
export interface BuiltSystemPrompt {
    /** The verbatim prompt fed to inference. */
    readonly full: string;
    /**
     * The prompt with the workspace-root framing files replaced by
     * `<content of file …>` placeholders. Equal to {@link full} when the
     * handler's `systemPrompt` mode excludes those files (no placeholders
     * to substitute).
     */
    readonly redacted: string;
}

/** A section that is identical between the inference and audit-log views. */
function verbatim(text: string): SystemPromptSection {
    return { full: text, redacted: text };
}

/**
 * A framing-file section (`# Identity` / `# Context`).
 * The full variant carries the file body verbatim; the redacted variant
 * replaces the body with a `<content of file …>` placeholder so the
 * audit log keeps per-run signal without the bulky framing-file noise.
 */
function framingFileSection(heading: string, fileName: string, body: string): SystemPromptSection {
    return {
        full: `# ${heading}\n\n${body}`,
        redacted: `# ${heading}\n\n<content of file ${fileName}>`,
    };
}

/**
 * Inputs the PromptBuilder needs to ask the bastion for plugin-
 * contributed event-context sections. Carried as a single record so
 * test harnesses can pass `null` to skip the fetch without a runtime
 * env shim.
 */
export interface EventContextFetchInput {
    /** Bastion base URL (passed config `bastionUrl`). */
    readonly bastionUrl: string;
    /** Event id this agentrun is processing. */
    readonly eventId: string;
    /** Agentrun id about to start running. */
    readonly agentrunId: string;
    /**
     * Logger child for warnings about fetch failures. The PromptBuilder
     * keeps fetch errors non-fatal — event context is best-effort
     * enrichment, not a hard dependency — but the operator should see
     * a warning when a gateway is misbehaving.
     */
    readonly log: { warn: (record: object, message: string) => void };
    /**
     * Optional override for the overall fetch timeout. Defaults to 10s
     * — providers are already bounded internally by the gateway, so
     * this only catches gateway-level hangs.
     */
    readonly timeoutMs?: number;
}

/** One section as returned by the bastion. Mirrors the gateway type. */
interface EventContextSection {
    readonly pluginId: string;
    readonly text: string;
}

/** Response shape served by `POST /event-context/`. */
interface EventContextResponse {
    readonly sections: readonly EventContextSection[];
}

const EVENT_CONTEXT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch plugin-contributed sections from the bastion's
 * `/event-context/` gateway. Best-effort: on any fetch failure
 * (network error, timeout, non-200, malformed body) the helper logs a
 * warning and returns an empty list so the system prompt still
 * assembles. The bastion fans out to every registered provider in
 * parallel and isolates per-provider rejections, so this side only
 * has to deal with transport-layer concerns.
 */
async function fetchEventContextSections(
    input: EventContextFetchInput,
): Promise<readonly EventContextSection[]> {
    const url = `${input.bastionUrl.replace(/\/$/, "")}/event-context/`;
    const timeoutMs = input.timeoutMs ?? EVENT_CONTEXT_FETCH_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ eventId: input.eventId, agentrunId: input.agentrunId }),
            signal: controller.signal,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            input.log.warn(
                { status: res.status, body: body.slice(0, 200) },
                "event-context gateway returned non-200",
            );
            return [];
        }
        const parsed = (await res.json()) as EventContextResponse;
        if (!parsed || !Array.isArray(parsed.sections)) {
            input.log.warn({}, "event-context gateway returned malformed body");
            return [];
        }
        return parsed.sections;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        input.log.warn({ err: message }, "event-context fetch failed");
        return [];
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Build the bullet list of dynamic context that varies per call: the
 * wall-clock time the prompt was assembled, the event topic being
 * processed, the handler file in use (with the parent it inherits
 * from, when merged), and whether the handler will mirror its final
 * text reply into the chat history via `outputChat`.
 */
function buildRuntimeSection(handler: HandlerFile, topic: string, privileged: boolean): string {
    const lines = [
        `- Current time: ${formatRuntimeTime(new Date(), resolveTimezone())}`,
        `- Event topic: \`${topic}\``,
        `- Handler file: \`${handler.relativePath}\``,
    ];
    if (handler.inheritsFrom.length > 0) {
        const ancestors = handler.inheritsFrom.map((p) => `\`${p}\``).join(" ← ");
        lines.push(`- Inheriting from: ${ancestors}`);
    }
    lines.push(`- outputChat: ${handler.header.outputChat === true}`);
    // Privileged runs descend from a trusted user-input source (the
    // operator at the local terminal or on Telegram). Tools that gate
    // risky reads / writes on this flag will refuse non-privileged
    // calls, so the agent should know up front whether they're
    // available rather than discovering it via a tool error.
    lines.push(
        `- privileged: ${privileged ? "yes, the prompt stems from the system owner" : "no"}`,
    );
    return lines.join("\n");
}

/**
 * Compose the per-call user prompt from the agentrun's seed prompt
 * and structured payload.
 *
 * The seed prompt comes through verbatim (with the same per-section
 * truncation as workspace files). The payload is JSON-rendered with
 * three layers of bounding:
 *
 * 1. Each object key is sanitized to printable ASCII and capped at
 *    {@link MAX_KEY_CHARS}.
 * 2. Each string leaf value is capped at {@link MAX_VALUE_CHARS} with
 *    a `…[truncated, original N chars]` marker.
 * 3. The rendered JSON as a whole is capped at {@link MAX_PAYLOAD_CHARS}.
 *
 * Empty / null / `{}` payloads are skipped — only the seed prompt
 * comes through. When both are absent the function returns `""`.
 *
 * @param runPrompt The agentrun's optional seed prompt (the `prompt`
 *   column on the row).
 * @param payload The agentrun's structured payload (the `payload`
 *   jsonb column on the row), an arbitrary JSON value.
 */
export function buildPrompt(
    runPrompt: string | null,
    payload: unknown,
    scratchListing?: string | null,
): string {
    const sections: string[] = [];

    if (runPrompt && runPrompt.trim().length > 0) {
        sections.push(truncate(runPrompt, MAX_FILE_CHARS));
    }

    const payloadJson = renderPayload(payload);
    if (payloadJson !== null) {
        sections.push(`# Payload\n\n\`\`\`json\n${payloadJson}\n\`\`\``);
    }

    if (scratchListing !== undefined && scratchListing !== null && scratchListing.length > 0) {
        sections.push(scratchListing);
    }

    if (sections.length === 0) {
        return "";
    }
    return truncate(sections.join("\n\n"), MAX_PROMPT_CHARS);
}

/**
 * List the files staged at `/scratch/<eventId>/` for the prompt
 * scaffold. Returns a markdown block ready to append to the user
 * prompt, or `null` when the dir is missing or empty (in which case
 * the section is skipped entirely so the model isn't told about a
 * concept that doesn't apply to this run).
 *
 * Sizes are listed in bytes; the model is good at scaling those.
 * Files are listed in name order for stability across runs. Hidden
 * dotfiles are skipped — same convention as `WorkspaceWatcher`.
 */
export function buildScratchListing(eventId: string): string | null {
    if (typeof eventId !== "string" || eventId.length === 0) {
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
    if (lines.length === 0) {
        return null;
    }
    return `# Files staged for this event\n\nThese files live in this event's shared scratch directory. They are visible to every MCP under the same path, so you can pass these paths verbatim to MCP tools (e.g. a PDF parser):\n\n${lines.join("\n")}`;
}

/**
 * Sanitize and JSON-render a payload for inclusion in the user
 * prompt. Returns `null` when the payload is empty (`null`,
 * `undefined`, or `{}`); the caller skips the section entirely in
 * that case.
 */
function renderPayload(payload: unknown): string | null {
    if (payload === null || payload === undefined) {
        return null;
    }
    if (
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        Object.keys(payload).length === 0
    ) {
        return null;
    }
    const sanitized = sanitizeValue(payload);
    const json = JSON.stringify(sanitized, null, 2);
    return truncate(json, MAX_PAYLOAD_CHARS);
}

/**
 * Recursively walk a JSON-serializable value, sanitizing object
 * keys and capping string-leaf lengths. Arrays and primitives pass
 * through structurally; only the keys/values mutate.
 */
function sanitizeValue(value: unknown): unknown {
    if (typeof value === "string") {
        return capString(value, MAX_VALUE_CHARS);
    }
    if (Array.isArray(value)) {
        return value.map(sanitizeValue);
    }
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            out[sanitizeKey(key)] = sanitizeValue(child);
        }
        return out;
    }
    return value;
}

/**
 * Strip non-printable / non-ASCII characters from a payload key,
 * then cap to {@link MAX_KEY_CHARS}. Empty keys (or keys that
 * sanitize to empty) become `"_"` so the resulting JSON is still
 * well-formed.
 */
function sanitizeKey(key: string): string {
    // Replace anything outside printable ASCII with `_`. Newlines,
    // tabs, control bytes, multi-byte UTF-8 sequences (umlauts,
    // emoji, etc.) all fall to `_`.
    const ascii = key.replace(/[^\x20-\x7E]/g, "_").slice(0, MAX_KEY_CHARS);
    return ascii.length === 0 ? "_" : ascii;
}

/** Cap a string at `max` chars, appending the `…[truncated, …]` marker. */
function capString(value: string, max: number): string {
    if (value.length <= max) {
        return value;
    }
    return `${value.slice(0, max)}…[truncated, original ${value.length} chars]`;
}

/**
 * Scan `<workspaceRoot>/skills/` for shared-recipe skills and render
 * them as the `# Available skills` system-prompt section.
 *
 * A skill is `skills/<id>/SKILL.md` where the SKILL.md has at least a
 * `description` field in its YAML frontmatter. Entries that don't match
 * this shape (loose files, folders without SKILL.md, malformed YAML,
 * missing description) are silently skipped — the catalog is
 * best-effort, not a validation surface.
 *
 * The `(read)` marker is rendered for skills whose frontmatter does
 * not declare a non-empty `tools` field: with no tools the skill is
 * pure context and can be consumed by `fs_read` alone; otherwise it
 * has to be invoked via `call_handler` so the agent execution context
 * grants those tools.
 *
 * @returns The fully-formatted section (heading + preamble + bullets),
 *   or `null` when the `skills/` directory is missing or contains no
 *   valid skills (in which case the section is omitted entirely).
 */
function buildAvailableSkillsSection(): string | null {
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
        const skillFile = path.join(skillDir, "SKILL.md");
        let raw: string;
        try {
            raw = readFileSync(skillFile, "utf8");
        } catch {
            continue;
        }
        const frontmatter = parseSkillFrontmatter(raw);
        if (frontmatter === null) {
            continue;
        }
        const description = frontmatter.description;
        if (typeof description !== "string" || description.trim().length === 0) {
            continue;
        }
        const tools = frontmatter.tools;
        const hasTools = typeof tools === "string" && tools.trim().length > 0;
        const trimmedDescription = description.trim();
        const cappedDescription =
            trimmedDescription.length > MAX_SKILL_DESCRIPTION_CHARS
                ? `${trimmedDescription.slice(0, MAX_SKILL_DESCRIPTION_CHARS)}…`
                : trimmedDescription;
        const marker = hasTools ? "" : " (read)";
        bullets.push({ id, line: `- \`${id}\`${marker}: ${cappedDescription}` });
    }

    if (bullets.length === 0) {
        return null;
    }

    bullets.sort((a, b) => a.id.localeCompare(b.id));

    const preamble = [
        "The following skills are available in the `skills/` folder.",
        'Use like `fs_read({path: "skills/<id>/SKILL.md"})` or',
        '`call_handler({topic: "skills:<id>", handler: "SKILL", prompt?, payload?})`.',
        "If reading is sufficient, this is marked in the list.",
    ].join(" ");

    return `# Available skills\n\n${preamble}\n\n${bullets.map((b) => b.line).join("\n")}`;
}

/**
 * Parse the YAML frontmatter block out of a SKILL.md source string.
 * Returns the parsed mapping, or `null` if there is no frontmatter,
 * the YAML is malformed, or it doesn't parse to a mapping.
 *
 * This is intentionally separate from {@link HandlerFile}'s
 * `parseHandler` — that function does typed handler-header validation
 * (model, temperature, …) we don't want to inherit here. The regex is
 * the same shape as in `HandlerFile`.
 */
function parseSkillFrontmatter(source: string): Record<string, unknown> | null {
    const trimmed = source.trim();
    const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n?---\r?\n?([\s\S]*)$/);
    if (!match) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = parseYaml(match[1] ?? "");
    } catch {
        return null;
    }
    if (parsed === null || parsed === undefined) {
        return null;
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
    }
    return parsed as Record<string, unknown>;
}

/**
 * Read a file at `<workspaceRoot>/<relativePath>` synchronously,
 * returning its trimmed contents (per-file-truncated) or `null` if
 * the file does not exist. Other I/O errors propagate so the caller
 * doesn't silently mistake e.g. EACCES for a missing file.
 */
function readWorkspaceFile(relativePath: string): string | null {
    const absolute = path.join(HandlerFile.getWorkspaceRoot(), relativePath);
    try {
        const raw = readFileSync(absolute, "utf8");
        return truncate(raw.trim(), MAX_FILE_CHARS);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw err;
    }
}

/**
 * Cap a string at `max` characters. If the input exceeds the cap,
 * returns the head plus a marker noting the original length so the
 * model can tell the value is truncated.
 */
function truncate(value: string, max: number): string {
    if (value.length <= max) {
        return value;
    }
    return `${value.slice(0, max)}\n…[truncated, original ${value.length} chars]`;
}

/**
 * Format a `Date` for the agent system prompt's "Current time" line:
 * `Friday, 2026-05-19T18:43:12 in timezone Europe/Berlin`.
 *
 * Weekday name + ISO-like local time + the IANA tz label, all
 * relative to `timezone`. Built from `Intl.DateTimeFormat.formatToParts`
 * so we control the separators directly — the locale-default
 * formatter inserts AM/PM and locale punctuation we don't want.
 *
 * Exported so unit tests can pin the format against a fixed date and
 * timezone.
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
