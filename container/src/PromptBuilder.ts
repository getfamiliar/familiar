import { readFileSync } from "node:fs";
import path from "node:path";
import { HandlerFile } from "./HandlerFile";

/**
 * Hard cap on the character length of each individually-included
 * section (a workspace file, the handler body, the payload JSON, the
 * run prompt). Per-section truncation happens before assembly.
 */
const MAX_FILE_CHARS = 8000;

/**
 * Hard cap on the assembled system prompt. Functions as a safety net
 * after per-section truncation; if the assembled total still exceeds
 * this, the trailing portion is cut off. With four ~8000-char sections
 * the cap leaves headroom for section framing.
 */
const MAX_SYSTEM_CHARS = 32000;

/**
 * Hard cap on the assembled user prompt. Mostly relevant for large
 * payloads; the handler body is in the system prompt instead.
 */
const MAX_PROMPT_CHARS = 16000;

/**
 * Builds the two prompts an {@link AgentRunner} hands to its
 * {@link import("ai").ToolLoopAgent}: the system instructions and the
 * per-call user message.
 *
 * The split is fixed:
 *
 * - **System** = SOUL.md + CONTEXT.md from the workspace root
 *   (skipped silently if missing) + the handler body + the list of
 *   tools the agent is allowed to call.
 * - **User** = the agentrun's seed prompt (if any) + a JSON dump of
 *   the agentrun's payload.
 *
 * Per-section truncation is enforced as content is gathered; an
 * overall cap is applied after assembly as a safety net. Both forms
 * append a `…[truncated, original N chars]` marker so the model
 * knows the value is incomplete.
 */
export class PromptBuilder {
    /**
     * Compose the system prompt. SOUL.md and CONTEXT.md are read from
     * the workspace root (using {@link HandlerFile.getWorkspaceRoot});
     * missing files are skipped without erroring.
     *
     * @param handlerBody The markdown body of the handler file (the
     *   per-handler policy). Empty string is allowed and yields no
     *   "Task" section.
     * @param toolNames Ids of tools the agent is permitted to call
     *   for this run. Listed under "Available tools"; an empty array
     *   produces "(none)".
     */
    static buildSystem(handlerBody: string, toolNames: readonly string[]): string {
        const sections: string[] = [];

        const soul = readWorkspaceFile("SOUL.md");
        if (soul !== null) {
            sections.push(`# Identity\n\n${soul}`);
        }

        const context = readWorkspaceFile("CONTEXT.md");
        if (context !== null) {
            sections.push(`# Context\n\n${context}`);
        }

        if (handlerBody.trim().length > 0) {
            sections.push(`# Task\n\n${truncate(handlerBody, MAX_FILE_CHARS)}`);
        }

        const toolList =
            toolNames.length > 0 ? toolNames.map((name) => `- ${name}`).join("\n") : "(none)";
        sections.push(`# Available tools\n\n${toolList}`);

        return truncate(sections.join("\n\n"), MAX_SYSTEM_CHARS);
    }

    /**
     * Compose the per-call user prompt: the seed prompt (if any) and a
     * pretty-printed JSON dump of the payload under a `# Payload`
     * heading.
     *
     * @param runPrompt The agentrun's optional seed prompt (the
     *   `prompt` column on the row). `null` or empty string emits no
     *   prompt section.
     * @param payload Arbitrary JSON-serializable value from the row's
     *   payload column. `null` / `undefined` are coerced to `{}` so
     *   the section always renders something.
     */
    static buildPrompt(runPrompt: string | null, payload: unknown): string {
        const sections: string[] = [];

        if (runPrompt && runPrompt.trim().length > 0) {
            sections.push(truncate(runPrompt, MAX_FILE_CHARS));
        }

        const payloadJson = JSON.stringify(payload ?? {}, null, 2);
        sections.push(`# Payload\n\n\`\`\`json\n${truncate(payloadJson, MAX_FILE_CHARS)}\n\`\`\``);

        return truncate(sections.join("\n\n"), MAX_PROMPT_CHARS);
    }
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
