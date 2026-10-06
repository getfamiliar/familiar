/**
 * Prompt placeholders — the `{NAME}` tokens a workspace prompt template
 * (`PROMPT.md`, or a handler's `systemPrompt: <path.md>`) may contain.
 *
 * The container renders templates; the host owns plugin-registered
 * placeholders and the `familiar prompt placeholders` CLI. Both sides
 * need the core definitions (the container to know which names it
 * resolves itself, the host to reject plugin registrations that collide
 * with them and to list them), which is why they live here.
 */

/** Workspace-root template used by handlers with `systemPrompt: default` (or none declared). */
export const PROMPT_TEMPLATE_FILE = "PROMPT.md";

/**
 * Valid placeholder name: upper-case letter, then upper-case letters,
 * digits or underscores. Workspace includes (`{path.md}`) are a
 * separate token form and are not names.
 */
export const PROMPT_PLACEHOLDER_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Whether a placeholder's value is the same for every run of a handler
 * (`static`, safe in the cacheable system-prompt prefix) or changes per
 * run (`dynamic`, belongs after `{CACHE_MARKER}`).
 */
export type PromptPlaceholderKind = "static" | "dynamic";

/** Name, purpose and cache behaviour of one placeholder. */
export interface PromptPlaceholderDefinition {
    readonly name: string;
    readonly description: string;
    readonly kind: PromptPlaceholderKind;
}

/** Name of the marker splitting the template into system prompt and user-message head. */
export const CACHE_MARKER_PLACEHOLDER = "CACHE_MARKER";

/**
 * Placeholders resolved by the container core. Rendered order in
 * `familiar prompt placeholders` follows this list.
 */
export const CORE_PROMPT_PLACEHOLDERS: readonly PromptPlaceholderDefinition[] = [
    {
        name: CACHE_MARKER_PLACEHOLDER,
        description:
            "Splits the template: everything before it is the (cacheable) system prompt, everything after it leads the current user message.",
        kind: "static",
    },
    {
        name: "HANDLER_CONTENT",
        description:
            "Body of the resolved handler file (merged with its parents). Placeholders inside it are expanded too.",
        kind: "static",
    },
    {
        name: "HANDLER_PATH",
        description: "Workspace-relative path of the handler file, e.g. `chat/telegram/index.md`.",
        kind: "static",
    },
    {
        name: "HANDLER_INHERITS",
        description: "Parent handler files this handler is merged with, as `a ← b`, or `(none)`.",
        kind: "static",
    },
    {
        name: "SKILL_LIST",
        description: "Bullet list of the skills in `skills/` (id and description).",
        kind: "static",
    },
    {
        name: "TOOL_LIST",
        description: "Bullet list of the tools preloaded for this run.",
        kind: "static",
    },
    {
        name: "PYTHON_PACKAGE_LIST",
        description: "Comma-separated python packages installed in the agent container.",
        kind: "static",
    },
    {
        name: "WRITABLE_PATH_LIST",
        description:
            "Comma-separated `core.writablePaths` globs a non-privileged run may write to.",
        kind: "static",
    },
    {
        name: "RUNTIME_LIST",
        description:
            "Bullet list of run facts: current time, event topic, handler file, inheritance, outputChat, privileged.",
        kind: "dynamic",
    },
    {
        name: "CURRENT_TIME",
        description: "Current wall-clock time with weekday and timezone.",
        kind: "dynamic",
    },
    {
        name: "EVENT_TOPIC",
        description: "Topic of the event this run processes, e.g. `chat:telegram`.",
        kind: "dynamic",
    },
    {
        name: "PRIVILEGED",
        description: "`yes` when the run stems from the system owner, otherwise `no`.",
        kind: "dynamic",
    },
    {
        name: "STAGED_FILE_LIST",
        description: "Bullet list of files staged in this event's `/scratch/<event-id>/` folder.",
        kind: "dynamic",
    },
];

/**
 * Thrown when a plugin registers a placeholder whose name is invalid or
 * already taken by the core or another plugin.
 */
export class PromptPlaceholderConflictError extends Error {
    readonly placeholderName: string;

    /**
     * @param placeholderName The offending name.
     * @param message Human-readable reason.
     */
    constructor(placeholderName: string, message: string) {
        super(message);
        this.name = "PromptPlaceholderConflictError";
        this.placeholderName = placeholderName;
    }
}

/**
 * Whether `name` is resolved by the container core.
 *
 * @param name Placeholder name without braces.
 * @returns `true` for names in {@link CORE_PROMPT_PLACEHOLDERS}.
 */
export function isCorePromptPlaceholder(name: string): boolean {
    return CORE_PROMPT_PLACEHOLDERS.some((definition) => definition.name === name);
}
