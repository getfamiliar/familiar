import {
    isCorePromptPlaceholder,
    PROMPT_PLACEHOLDER_NAME_PATTERN,
    PromptPlaceholderConflictError,
    type PromptPlaceholderRegistration,
} from "@getfamiliar/shared";

/** A registration plus the id of the plugin that made it. */
export interface RegisteredPromptPlaceholder extends PromptPlaceholderRegistration {
    readonly pluginId: string;
}

/**
 * Holds the named placeholders plugins contributed via
 * `ctx.prompt.registerPlaceholder`. One instance per host process. The
 * bastion's `/prompt-placeholders/` route resolves the names a template
 * actually uses against it; `familiar prompt placeholders` lists it.
 */
export class PromptPlaceholderRegistry {
    private readonly entries = new Map<string, RegisteredPromptPlaceholder>();

    /**
     * Register a placeholder for `pluginId`.
     *
     * @param pluginId Id of the registering plugin.
     * @param registration Name, description and value function.
     * @throws {PromptPlaceholderConflictError} When the name is malformed,
     *   reserved by the core, or already registered by a plugin.
     */
    register(pluginId: string, registration: PromptPlaceholderRegistration): void {
        const { name } = registration;
        if (!PROMPT_PLACEHOLDER_NAME_PATTERN.test(name)) {
            throw new PromptPlaceholderConflictError(
                name,
                `plugin ${pluginId}: placeholder name "${name}" must match [A-Z][A-Z0-9_]*`,
            );
        }
        if (isCorePromptPlaceholder(name)) {
            throw new PromptPlaceholderConflictError(
                name,
                `plugin ${pluginId}: placeholder {${name}} is reserved by the core`,
            );
        }
        const existing = this.entries.get(name);
        if (existing !== undefined) {
            throw new PromptPlaceholderConflictError(
                name,
                `plugin ${pluginId}: placeholder {${name}} is already registered by plugin ${existing.pluginId}`,
            );
        }
        this.entries.set(name, { ...registration, pluginId });
    }

    /**
     * Look up one placeholder by name.
     *
     * @param name Placeholder name without braces.
     * @returns The registration, or `undefined` when no plugin registered it.
     */
    get(name: string): RegisteredPromptPlaceholder | undefined {
        return this.entries.get(name);
    }

    /**
     * Every registered placeholder, sorted by name.
     *
     * @returns The registrations.
     */
    list(): readonly RegisteredPromptPlaceholder[] {
        return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
}
