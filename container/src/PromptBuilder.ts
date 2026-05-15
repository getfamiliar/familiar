import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { HandlerFile } from "./HandlerFile.js";

/**
 * Absolute path of the per-container scratch root. Bind-mounted to the
 * host's `tmp/scratch/` and to every MCP container at the same
 * absolute path, so `/scratch/<event-id>/<name>` is the one path string
 * the agent uses for both `file_read` and MCP tool arguments.
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
 * this, the trailing portion is cut off. With four ~8000-char sections
 * the cap leaves headroom for section framing.
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
 * Compose the system prompt the {@link AgentRunner} hands to its
 * {@link import("ai").ToolLoopAgent}.
 *
 * SOUL.md, ENVIRONMENT.md, and CONTEXT.md are read from the workspace
 * root (using {@link HandlerFile.getWorkspaceRoot}); missing files are
 * skipped without erroring. Per-section truncation is enforced as
 * content is gathered; an overall cap is applied after assembly as a
 * safety net. Truncated values get a `…[truncated, original N chars]`
 * marker so the model knows the value is incomplete.
 *
 * @param handler The resolved handler file. Body becomes the `# Task`
 *   section; path / inheritance / `outputChat` feed the `# Runtime`
 *   section at the end.
 * @param toolNames Ids of tools the agent is permitted to call for
 *   this run. Listed under "Available tools"; an empty array produces
 *   "(none)".
 * @param topic The event topic this agentrun is processing (e.g.
 *   `chat:telegram`). Surfaced in the `# Runtime` section so the agent
 *   can reason about which channel/source produced the event.
 * @param privileged Whether the agentrun descends from a trusted
 *   user-input source. Surfaced in the `# Runtime` section so the
 *   agent knows which trust-gated tools are available to it.
 */
export function buildSystemPrompt(
    handler: HandlerFile,
    toolNames: readonly string[],
    topic: string,
    privileged: boolean,
): string {
    const sections: string[] = [];

    const soul = readWorkspaceFile("SOUL.md");
    if (soul !== null) {
        sections.push(`# Identity\n\n${soul}`);
    }

    const environment = readWorkspaceFile("ENVIRONMENT.md");
    if (environment !== null) {
        sections.push(`# Environment\n\n${environment}`);
    }

    const context = readWorkspaceFile("CONTEXT.md");
    if (context !== null) {
        sections.push(`# Context\n\n${context}`);
    }

    if (handler.body.trim().length > 0) {
        sections.push(`# Handler\n\n${truncate(handler.body, MAX_FILE_CHARS)}`);
    }

    const toolList =
        toolNames.length > 0 ? toolNames.map((name) => `- ${name}`).join("\n") : "(none)";
    sections.push(`# Available tools\n\n${toolList}`);

    sections.push(`# Runtime\n\n${buildRuntimeSection(handler, topic, privileged)}`);

    return truncate(sections.join("\n\n"), MAX_SYSTEM_CHARS);
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
        `- Current time: ${new Date().toISOString()}`,
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
