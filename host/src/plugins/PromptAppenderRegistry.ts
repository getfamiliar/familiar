import type { PromptAppender } from "@getfamiliar/shared";

/**
 * One entry in the registry: the plugin id of the registering plugin
 * (captured at register time so logging and bastion responses can name
 * the source) paired with the appender function itself.
 */
export interface RegisteredPromptAppender {
    readonly pluginId: string;
    readonly fn: PromptAppender;
}

/**
 * Holds the {@link PromptAppender}s plugins contributed via
 * `ctx.prompt.registerPromptAppender(fn)`. One instance per host
 * process, shared across every plugin's `HostContext`. The bastion's
 * `/prompt-appenders/` route reads from this registry on every prompt
 * assembly and fans the appenders out in parallel.
 *
 * Mirrors `MailRegistry` / `CalendarRegistry` in shape and lifetime.
 * Unlike those, a single plugin may register multiple appenders — a
 * plugin that knows several orthogonal facts about an event is free to
 * decompose them rather than concatenate by hand. Registration order
 * is preserved so the assembled section list is stable across calls.
 */
export class PromptAppenderRegistry {
    private readonly entries: RegisteredPromptAppender[] = [];

    /**
     * Register an appender for `pluginId`. Plugins may register more
     * than one — each call appends. There is no unregister surface
     * today because plugin lifetimes match the daemon's.
     *
     * @param pluginId Id of the registering plugin.
     * @param fn The appender.
     * @throws If `pluginId` is empty.
     */
    register(pluginId: string, fn: PromptAppender): void {
        if (pluginId.length === 0) {
            throw new Error("PromptAppenderRegistry.register: pluginId must be non-empty");
        }
        this.entries.push({ pluginId, fn });
    }

    /**
     * Snapshot of every registered appender in registration order.
     * Used by the bastion gateway to fan calls out in parallel.
     *
     * @returns The registered appenders.
     */
    list(): readonly RegisteredPromptAppender[] {
        return this.entries;
    }
}
