import type { EventContextProvider } from "@getfamiliar/shared";

/**
 * One entry in the registry: the plugin id of the registering plugin
 * (captured at register time so logging and bastion responses can name
 * the source) paired with the provider function itself.
 */
export interface RegisteredEventContextProvider {
    readonly pluginId: string;
    readonly fn: EventContextProvider;
}

/**
 * Holds the {@link EventContextProvider}s plugins contributed via
 * `ctx.events.registerContextProvider(fn)`. One instance per host
 * process, shared across every plugin's `HostContext`. The bastion's
 * `/event-context/` gateway reads from this registry on every prompt
 * assembly and fans the providers out in parallel.
 *
 * Mirrors `MailRegistry` / `CalendarRegistry` in shape and lifetime.
 * Unlike those, a single plugin may register multiple providers — a
 * plugin that knows several orthogonal facts about an event is free to
 * decompose them rather than concatenate by hand. Registration order
 * is preserved so the assembled section list is stable across calls.
 */
export class EventContextRegistry {
    private readonly entries: RegisteredEventContextProvider[] = [];

    /**
     * Register a provider for `pluginId`. Plugins may register more
     * than one — each call appends. Returns nothing; there is no
     * unregister surface today because plugin lifetimes match the
     * daemon's.
     */
    register(pluginId: string, fn: EventContextProvider): void {
        if (pluginId.length === 0) {
            throw new Error("EventContextRegistry.register: pluginId must be non-empty");
        }
        this.entries.push({ pluginId, fn });
    }

    /**
     * Snapshot of every registered provider in registration order.
     * Used by the bastion gateway to fan calls out in parallel.
     */
    list(): readonly RegisteredEventContextProvider[] {
        return this.entries;
    }
}
