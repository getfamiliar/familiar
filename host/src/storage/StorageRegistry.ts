import type { StorageApi, StorageProvider } from "@getfamiliar/shared";

/**
 * Maps `pluginId` → registered {@link StorageProvider}. Owned by the
 * `PluginHost`; the `StorageService` resolves each mount's `plugin:`
 * through it.
 */
export class StorageRegistry implements StorageApi {
    private readonly providers = new Map<string, StorageProvider>();

    /**
     * Register a provider. Each plugin may register at most once.
     *
     * @throws Error on a second registration for the same plugin (wiring bug).
     */
    registerProvider(provider: StorageProvider): void {
        if (this.providers.has(provider.pluginId)) {
            throw new Error(
                `storage provider for plugin "${provider.pluginId}" is already registered — ` +
                    "this is a wiring bug, not a feature.",
            );
        }
        this.providers.set(provider.pluginId, provider);
    }

    /** @returns The provider for `pluginId`, or `undefined`. */
    byPluginId(pluginId: string): StorageProvider | undefined {
        return this.providers.get(pluginId);
    }

    /** @returns All providers in registration order. */
    all(): readonly StorageProvider[] {
        return [...this.providers.values()];
    }

    /** @returns The plugin ids of all registered providers. */
    pluginIds(): readonly string[] {
        return [...this.providers.keys()];
    }
}
