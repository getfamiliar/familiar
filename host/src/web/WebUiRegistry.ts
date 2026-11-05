import type { WebUi } from "@getfamiliar/shared";

/** Outcome of {@link WebUiRegistry.select}. */
export type WebUiSelection =
    | { readonly kind: "selected"; readonly pluginId: string; readonly ui: WebUi }
    | { readonly kind: "none" }
    | {
          readonly kind: "notProvided";
          readonly preferredId: string;
          readonly available: readonly string[];
      }
    | { readonly kind: "ambiguous"; readonly available: readonly string[] };

/**
 * The web UIs (root controller + optional auth-page renderer) plugins returned from their `webUi(ctx)`
 * hook, keyed by plugin id. One instance per host process; the webserver
 * picks one per app build ({@link select}) and rebuilds its app whenever
 * the set changes ({@link onChange}), e.g. after a plugin restart.
 */
export class WebUiRegistry {
    private readonly controllers = new Map<string, WebUi>();
    private readonly listeners = new Set<() => void>();

    /**
     * Register (or replace) a plugin's web UI.
     *
     * @param pluginId Providing plugin.
     * @param ui Its web UI.
     */
    set(pluginId: string, ui: WebUi): void {
        this.controllers.set(pluginId, ui);
        this.notify();
    }

    /**
     * Drop a plugin's web UI (plugin restart). No-op when it has none.
     *
     * @param pluginId The restarting plugin.
     */
    unregisterPlugin(pluginId: string): void {
        if (this.controllers.delete(pluginId)) {
            this.notify();
        }
    }

    /**
     * Ids of the plugins currently providing a web UI, sorted.
     *
     * @returns Plugin ids.
     */
    listPluginIds(): readonly string[] {
        return [...this.controllers.keys()].sort();
    }

    /**
     * Pick the controller to serve: the `preferredId` one when given
     * (`webserver.uiPlugin`), else the only one. Several providers without
     * a preference are reported as ambiguous instead of guessing.
     *
     * @param preferredId Plugin id from `webserver.uiPlugin`, if set.
     * @returns The selection, or why there is none.
     */
    select(preferredId: string | undefined): WebUiSelection {
        const available = this.listPluginIds();
        if (preferredId !== undefined) {
            const ui = this.controllers.get(preferredId);
            return ui === undefined
                ? { kind: "notProvided", preferredId, available }
                : { kind: "selected", pluginId: preferredId, ui };
        }
        if (available.length === 0) {
            return { kind: "none" };
        }
        if (available.length > 1) {
            return { kind: "ambiguous", available };
        }
        const pluginId = available[0] as string;
        return {
            kind: "selected",
            pluginId,
            ui: this.controllers.get(pluginId) as WebUi,
        };
    }

    /**
     * Subscribe to changes of the registered set.
     *
     * @param listener Called after every set / unregister that changed something.
     * @returns Unsubscribe function.
     */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Call every listener. */
    private notify(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }
}
