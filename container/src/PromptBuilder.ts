import { readFileSync } from "node:fs";
import path from "node:path";
import { CACHE_MARKER_PLACEHOLDER, PROMPT_TEMPLATE_FILE } from "@getfamiliar/shared";
import { HandlerFile } from "./HandlerFile.js";
import {
    CORE_PLACEHOLDER_RESOLVERS,
    type CorePlaceholderContext,
    isContainerCorePlaceholder,
    isDynamicCorePlaceholder,
} from "./prompt/CorePlaceholders.js";
import { type PlaceholderUse, parseTemplate, renderTemplate } from "./prompt/PromptTemplate.js";
import { formatPreloadedSkills, type SkillFile } from "./SkillFile.js";
import { bastionAuthHeaders } from "./utils/BastionAuth.js";

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
 * sections the cap leaves headroom for section framing. Preloaded
 * skills are an explicit opt-in, so the cap grows by their length.
 */
const MAX_SYSTEM_CHARS = 32000;

/** Hard cap on the assembled user prompt. */
const MAX_PROMPT_CHARS = 16000;

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
 * Template rendered for handlers with `systemPrompt: none`: the handler
 * body alone, no workspace framing and no runtime facts.
 */
const NONE_TEMPLATE = "{HANDLER_CONTENT}";

/** `systemPrompt` value selecting the workspace-root `PROMPT.md`. */
const DEFAULT_TEMPLATE_MODE = "default";

/** `systemPrompt` value selecting {@link NONE_TEMPLATE}. */
const NONE_TEMPLATE_MODE = "none";

/** Default timeout for the bastion round-trips fetching plugin prompt content. */
const PLUGIN_FETCH_TIMEOUT_MS = 10_000;

/** Thrown when the prompt template a handler selects does not exist. */
export class PromptTemplateMissingError extends Error {
    /**
     * @param templatePath Workspace-relative template path.
     * @param handlerPath Workspace-relative handler path that selected it.
     */
    constructor(templatePath: string, handlerPath: string) {
        super(
            `prompt template ${templatePath} (selected by handler ${handlerPath}) does not exist in the workspace — ` +
                `create it, or point the handler's \`systemPrompt\` frontmatter at an existing template`,
        );
        this.name = "PromptTemplateMissingError";
    }
}

/**
 * How the PromptBuilder reaches the host for plugin prompt content
 * (named placeholders and appenders). Pass `null` instead to skip the
 * round-trips — used by tests and harnesses without a live bastion.
 */
export interface PluginPromptAccess {
    /** Bastion base URL (passed config `bastionUrl`). */
    readonly bastionUrl: string;
    /** Shared bastion token (passed config `bastionToken`). */
    readonly bastionToken: string;
    /**
     * The run to hand to plugins: real ids, or a synthetic description
     * for `familiar prompt dry-run`.
     */
    readonly run:
        | { readonly eventId: string; readonly agentrunId: string }
        | {
              readonly dryRun: {
                  readonly topic: string;
                  readonly handler: string;
                  readonly prompt: string | null;
                  readonly privileged: boolean;
              };
          };
    /**
     * Logger for fetch failures. Plugin content is best-effort
     * enrichment, so failures are logged and the prompt still assembles.
     */
    readonly log: { warn: (record: object, message: string) => void };
    /** Optional override for the per-request timeout. Defaults to 10s. */
    readonly timeoutMs?: number;
}

/** Inputs to {@link buildPromptParts}. */
export interface BuildPromptPartsInput {
    /** The resolved handler file; its `systemPrompt` selects the template. */
    readonly handler: HandlerFile;
    /** Event topic the run processes (e.g. `chat:telegram`). */
    readonly topic: string;
    /** Whether the run descends from a trusted user-input source. */
    readonly privileged: boolean;
    /** Ids of the tools preloaded for this run. */
    readonly toolNames: readonly string[];
    /**
     * Skills the handler preloads (see `loadPreloadedSkills`), rendered
     * untruncated into `{PRELOADED_SKILLS}`.
     */
    readonly preloadedSkills: readonly SkillFile[];
    /** Event id; locates staged files under `/scratch/<eventId>/`. */
    readonly eventId: string;
    /** Host access for plugin content, or `null` to skip it. */
    readonly plugins: PluginPromptAccess | null;
    /** Assembly instant; defaults to now. Injectable for tests. */
    readonly now?: Date;
    /**
     * Resolve every core placeholder, not only the ones the template
     * uses. Used by `familiar prompt dry-run` to show all values.
     */
    readonly shouldResolveAllCore?: boolean;
}

/** One plugin-appended section. */
export interface PromptAppenderSection {
    readonly pluginId: string;
    readonly text: string;
}

/** Output of {@link buildPromptParts}. */
export interface PromptParts {
    /** The system prompt fed to inference (part of the template before `{CACHE_MARKER}`). */
    readonly system: string;
    /**
     * The head of the current-run user message: the template part after
     * `{CACHE_MARKER}`, followed by plugin-appended sections.
     */
    readonly userHead: string;
    /**
     * Audit-log variants with every `{path.md}` include replaced by
     * `<content of file path>`, for `core.logSystemPrompt: non-static`.
     */
    readonly redacted: { readonly system: string; readonly userHead: string };
    /** Workspace-relative template path, or `null` for `systemPrompt: none`. */
    readonly templatePath: string | null;
    /** Every placeholder the template (and its includes) references. */
    readonly uses: readonly PlaceholderUse[];
    /** Resolved value per placeholder name (core and plugin). */
    readonly values: ReadonlyMap<string, string>;
    /** Plugin-appended sections, in registration order. */
    readonly appenderSections: readonly PromptAppenderSection[];
    /** Template problems worth a warning, phrased for a log line. */
    readonly warnings: readonly string[];
}

/**
 * Assemble the prompt for one agentrun from the handler's prompt
 * template (`PROMPT.md` by default).
 *
 * The template is plain workspace markdown with `{NAME}` placeholders
 * and `{path.md}` includes (see `prompt/PromptTemplate.ts`). Core
 * placeholders are resolved here; any other name is fetched from the
 * host's plugin placeholder registry. Plugin appenders are fetched in
 * parallel and appended to the user-message head.
 *
 * The split at `{CACHE_MARKER}` keeps the system prompt byte-stable per
 * handler as long as only static placeholders precede the marker — that
 * stable prefix is what providers cache, and in multi-turn chat it keeps
 * the prior history cacheable too. A per-run placeholder before the
 * marker is reported as a warning.
 *
 * @param input Handler, run facts and host access.
 * @returns The rendered parts plus diagnostics.
 * @throws {PromptTemplateMissingError} When the selected template file
 *   does not exist.
 */
export async function buildPromptParts(input: BuildPromptPartsInput): Promise<PromptParts> {
    const { handler } = input;
    const template = loadTemplate(handler);
    const preloadedSkills = formatPreloadedSkills(input.preloadedSkills);
    const maxSystemChars = MAX_SYSTEM_CHARS + preloadedSkills.length;
    const parsed = parseTemplate(template.source, {
        templateName: template.path ?? `${handler.relativePath} (systemPrompt: none)`,
        readInclude: readWorkspaceFile,
        templateSources: {
            HANDLER_CONTENT: truncate(handler.body, MAX_FILE_CHARS),
            PRELOADED_SKILLS: preloadedSkills,
        },
    });
    const warnings = [...parsed.warnings];

    const usedNames = [...new Set(parsed.uses.map((use) => use.name))];
    const coreContext: CorePlaceholderContext = {
        handler,
        topic: input.topic,
        privileged: input.privileged,
        toolNames: input.toolNames,
        eventId: input.eventId,
        now: input.now ?? new Date(),
    };
    const values = new Map<string, string>();
    const coreNames =
        input.shouldResolveAllCore === true
            ? Object.keys(CORE_PLACEHOLDER_RESOLVERS)
            : usedNames.filter((name) => CORE_PLACEHOLDER_RESOLVERS[name] !== undefined);
    for (const name of coreNames) {
        const resolve = CORE_PLACEHOLDER_RESOLVERS[name];
        if (resolve !== undefined) {
            values.set(name, resolve(coreContext));
        }
    }

    const pluginNames = usedNames.filter((name) => !isContainerCorePlaceholder(name));
    const [pluginValues, appenderSections] =
        input.plugins === null
            ? [{ values: {}, unknown: pluginNames, errors: {} }, []]
            : await Promise.all([
                  pluginNames.length > 0
                      ? fetchPluginPlaceholders(input.plugins, pluginNames)
                      : Promise.resolve({ values: {}, unknown: [], errors: {} }),
                  fetchAppenderSections(input.plugins),
              ]);
    for (const [name, value] of Object.entries(pluginValues.values)) {
        values.set(name, value);
    }
    const where = template.path ?? handler.relativePath;
    for (const name of pluginValues.unknown) {
        warnings.push(`${where}: unknown placeholder {${name}} kept verbatim`);
    }
    for (const [name, message] of Object.entries(pluginValues.errors)) {
        warnings.push(`${where}: plugin placeholder {${name}} failed: ${message}`);
    }
    const pluginProvided = new Set(Object.keys(pluginValues.values));
    const reportedDynamic = new Set<string>();
    for (const use of parsed.uses) {
        const isDynamic = isDynamicCorePlaceholder(use.name) || pluginProvided.has(use.name);
        if (use.isBeforeMarker && isDynamic && !reportedDynamic.has(use.name)) {
            reportedDynamic.add(use.name);
            warnings.push(
                `${where}: per-run placeholder {${use.name}} before {${CACHE_MARKER_PLACEHOLDER}} breaks prompt caching — move it below the marker`,
            );
        }
    }

    const full = renderTemplate(parsed, values);
    const redacted = renderTemplate(parsed, values, true);
    const appended = appenderSections.map((section) => section.text.trim());
    const withAppended = (head: string): string =>
        [head, ...appended].filter((part) => part.length > 0).join("\n\n");

    return {
        system: truncate(full.system, maxSystemChars),
        userHead: withAppended(full.userHead),
        redacted: {
            system: truncate(redacted.system, maxSystemChars),
            userHead: withAppended(redacted.userHead),
        },
        templatePath: template.path,
        uses: parsed.uses,
        values,
        appenderSections,
        warnings,
    };
}

/**
 * Resolve the template a handler selects via its `systemPrompt`
 * frontmatter: `default` (or absent) → `PROMPT.md`, `none` → the handler
 * body alone, anything else → that workspace-relative file.
 *
 * @param handler The resolved handler.
 * @returns The template path (`null` for `none`) and its text.
 * @throws {PromptTemplateMissingError} When the template file is missing.
 */
function loadTemplate(handler: HandlerFile): { path: string | null; source: string } {
    const mode = handler.header.systemPrompt ?? DEFAULT_TEMPLATE_MODE;
    if (mode === NONE_TEMPLATE_MODE) {
        return { path: null, source: NONE_TEMPLATE };
    }
    const templatePath = mode === DEFAULT_TEMPLATE_MODE ? PROMPT_TEMPLATE_FILE : mode;
    const source = readWorkspaceFile(templatePath);
    if (source === null) {
        throw new PromptTemplateMissingError(templatePath, handler.relativePath);
    }
    return { path: templatePath, source };
}

/** Response shape served by `POST /prompt-placeholders/`. */
interface PluginPlaceholdersResponse {
    readonly values: Readonly<Record<string, string>>;
    readonly unknown: readonly string[];
    readonly errors: Readonly<Record<string, string>>;
}

/**
 * Ask the host for the values of plugin-registered placeholders.
 * Best-effort: on a transport failure every name counts as failed and
 * stays verbatim in the prompt.
 *
 * @param access Bastion access and run description.
 * @param names Placeholder names the container core does not own.
 * @returns Values, unknown names and per-name errors.
 */
async function fetchPluginPlaceholders(
    access: PluginPromptAccess,
    names: readonly string[],
): Promise<PluginPlaceholdersResponse> {
    const body = await postToBastion(access, "/prompt-placeholders/", { ...access.run, names });
    if (body === null || typeof body !== "object" || !("values" in body)) {
        const errors = Object.fromEntries(
            names.map((name) => [name, "plugin gateway unavailable"]),
        );
        return { values: {}, unknown: [], errors };
    }
    const parsed = body as PluginPlaceholdersResponse;
    return {
        values: parsed.values ?? {},
        unknown: Array.isArray(parsed.unknown) ? parsed.unknown : [],
        errors: parsed.errors ?? {},
    };
}

/**
 * Fetch plugin appender sections. Best-effort: failures yield no sections.
 *
 * @param access Bastion access and run description.
 * @returns The non-empty sections in registration order.
 */
async function fetchAppenderSections(
    access: PluginPromptAccess,
): Promise<readonly PromptAppenderSection[]> {
    const body = await postToBastion(access, "/prompt-appenders/", access.run);
    if (
        body === null ||
        typeof body !== "object" ||
        !Array.isArray((body as { sections?: unknown }).sections)
    ) {
        return [];
    }
    return (body as { sections: PromptAppenderSection[] }).sections;
}

/**
 * POST a JSON body to a bastion route and parse the JSON answer. Any
 * failure (network error, timeout, non-200, malformed JSON) is logged as
 * a warning and yields `null`.
 *
 * @param access Bastion access, logger and timeout.
 * @param route Route path, e.g. `/prompt-appenders/`.
 * @param payload Request body.
 * @returns The parsed response, or `null` on failure.
 */
async function postToBastion(
    access: PluginPromptAccess,
    route: string,
    payload: object,
): Promise<unknown> {
    const url = `${access.bastionUrl.replace(/\/$/, "")}${route}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), access.timeoutMs ?? PLUGIN_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                ...bastionAuthHeaders(access.bastionToken),
                "content-type": "application/json",
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            access.log.warn(
                { status: res.status, body: text.slice(0, 200) },
                `prompt gateway ${route} returned ${res.status}: ${text.slice(0, 200)}`,
            );
            return null;
        }
        return await res.json();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        access.log.warn({ err: message }, `prompt gateway ${route} request failed: ${message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
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
export function buildPrompt(runPrompt: string | null, payload: unknown): string {
    const sections: string[] = [];

    if (runPrompt && runPrompt.trim().length > 0) {
        sections.push(truncate(runPrompt, MAX_FILE_CHARS));
    }

    const payloadJson = renderPayload(payload);
    if (payloadJson !== null) {
        sections.push(`# Payload\n\n\`\`\`json\n${payloadJson}\n\`\`\``);
    }

    if (sections.length === 0) {
        return "";
    }
    return truncate(sections.join("\n\n"), MAX_PROMPT_CHARS);
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
 * Read a file at `<workspaceRoot>/<relativePath>` synchronously,
 * returning its trimmed contents (per-file-truncated) or `null` if
 * the file does not exist. Other I/O errors propagate so the caller
 * doesn't silently mistake e.g. EACCES for a missing file.
 *
 * @param relativePath Workspace-relative path.
 * @returns The trimmed, truncated text, or `null` when missing.
 * @throws On I/O errors other than a missing file.
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
