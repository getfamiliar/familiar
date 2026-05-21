import type { MailApi, MailProvider } from "@getfamiliar/shared";

/**
 * Maps `pluginId` → registered {@link MailProvider}. The agent-facing
 * `mail_*` tools dispatch through this registry: they parse the mail
 * id's `<pluginId>:` prefix and look the provider up here.
 *
 * Mirrors `CalendarRegistry` in shape and lifetime: one instance per
 * host process, shared across every plugin's `HostContext`.
 */
export class MailRegistry implements MailApi {
    private readonly providers = new Map<string, MailProvider>();

    /**
     * Register a provider. Each plugin may register at most once; a
     * second call from the same plugin is a wiring bug and throws so
     * the daemon refuses to start instead of running with a silently
     * shadowed implementation.
     */
    registerProvider(provider: MailProvider): void {
        if (this.providers.has(provider.pluginId)) {
            throw new Error(
                `mail provider for plugin "${provider.pluginId}" is already registered — ` +
                    "this is a wiring bug, not a feature.",
            );
        }
        this.providers.set(provider.pluginId, provider);
    }

    /**
     * Look up the provider that owns a given mail id's plugin prefix.
     * Throws with an agent-readable message when no provider is
     * registered for the prefix — the alternative (silent fallthrough)
     * would surface as a confusing generic tool failure later.
     */
    forPluginId(pluginId: string): MailProvider {
        const provider = this.providers.get(pluginId);
        if (!provider) {
            throw new Error(
                `no mail provider registered for plugin "${pluginId}" — ` +
                    "is the plugin enabled and have you restarted the daemon?",
            );
        }
        return provider;
    }

    /**
     * Soft variant: returns `undefined` rather than throwing. Used by
     * callers that want to make absence non-fatal in context.
     */
    byPluginId(pluginId: string): MailProvider | undefined {
        return this.providers.get(pluginId);
    }
}
