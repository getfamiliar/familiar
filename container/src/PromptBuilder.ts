import { readFileSync } from "node:fs";
import path from "node:path";
import { HandlerFile } from "./HandlerFile";

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
 */
export function buildSystemPrompt(
    handler: HandlerFile,
    toolNames: readonly string[],
    topic: string,
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
        sections.push(`# Task\n\n${truncate(handler.body, MAX_FILE_CHARS)}`);
    }

    const toolList =
        toolNames.length > 0 ? toolNames.map((name) => `- ${name}`).join("\n") : "(none)";
    sections.push(`# Available tools\n\n${toolList}`);

    sections.push(`# Runtime\n\n${buildRuntimeSection(handler, topic)}`);

    return truncate(sections.join("\n\n"), MAX_SYSTEM_CHARS);
}

/**
 * Build the bullet list of dynamic context that varies per call: the
 * wall-clock time the prompt was assembled, the event topic being
 * processed, the handler file in use (with the parent it inherits
 * from, when merged), and whether the handler will mirror its final
 * text reply into the chat history via `outputChat`.
 */
function buildRuntimeSection(handler: HandlerFile, topic: string): string {
    const handlerLine = handler.inheritsFrom
        ? `Handler file: \`${handler.relativePath}\`, inheriting from \`${handler.inheritsFrom}\``
        : `Handler file: \`${handler.relativePath}\``;
    return [
        `- Current time: ${new Date().toISOString()}`,
        `- Event topic: \`${topic}\``,
        `- ${handlerLine}`,
        `- outputChat: ${handler.header.outputChat === true}`,
    ].join("\n");
}

/**
 * Compose the per-call user prompt from the agentrun's seed prompt.
 *
 * @param runPrompt The agentrun's optional seed prompt (the `prompt`
 *   column on the row). `null` or empty string yields an empty result.
 */
export function buildPrompt(runPrompt: string | null): string {
    if (!runPrompt || runPrompt.trim().length === 0) {
        return "";
    }
    return truncate(truncate(runPrompt, MAX_FILE_CHARS), MAX_PROMPT_CHARS);
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
