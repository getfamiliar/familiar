import type { CalendarProvider, CalendarRow } from "@getfamiliar/shared";

/**
 * Maps `pluginId` → registered {@link CalendarProvider}. Owned by
 * {@link CalendarService}; the agent-facing `cal_*` write tools
 * dispatch through this registry so they can route a write to whichever
 * plugin actually owns the target calendar.
 *
 * Lookups can happen from a calendar id (via row → pluginId) or from a
 * plugin id directly (when the caller already has a `CalendarRow`).
 */
export class CalendarRegistry {
    private readonly providers = new Map<string, CalendarProvider>();

    /**
     * Register a provider. Each plugin may register at most once; a
     * second call from the same plugin is a wiring bug and throws so
     * the daemon refuses to start instead of running with a silently
     * shadowed implementation.
     */
    register(provider: CalendarProvider): void {
        if (this.providers.has(provider.pluginId)) {
            throw new Error(
                `calendar provider for plugin "${provider.pluginId}" is already registered — ` +
                    "this is a wiring bug, not a feature.",
            );
        }
        this.providers.set(provider.pluginId, provider);
    }

    /**
     * Look up the provider that owns this calendar. Throws when no
     * provider has registered yet — the calendar row exists in the DB
     * but the plugin hasn't booted, which means writes against it must
     * fail loudly instead of silently no-op'ing.
     */
    forCalendar(calendar: CalendarRow): CalendarProvider {
        const provider = this.providers.get(calendar.pluginId);
        if (!provider) {
            throw new Error(
                `no calendar provider registered for plugin "${calendar.pluginId}" — ` +
                    "is the plugin enabled and have you restarted the daemon?",
            );
        }
        return provider;
    }

    /**
     * Look up by plugin id directly. Returns `undefined` rather than
     * throwing so callers (e.g. `cal_get_event_attachments` which must
     * resolve a provider from a stored event id prefix) can decide
     * whether the absence is fatal in context.
     */
    byPluginId(pluginId: string): CalendarProvider | undefined {
        return this.providers.get(pluginId);
    }
}
