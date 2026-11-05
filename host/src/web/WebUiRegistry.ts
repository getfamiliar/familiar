import type { WebUiEnv } from "@getfamiliar/shared";
import type { Hono } from "hono";

/** Outcome of {@link WebUiRegistry.select}. */
export type WebUiSelection =
    | { readonly kind: "selected"; readonly pluginId: string; readonly app: Hono<WebUiEnv> }
    | { readonly kind: "none" }
    | {
          readonly kind: "notProvided";
          readonly preferredId: string;
          readonly available: readonly string[];
      }
    | { readonly kind: "ambiguous"; readonly available: readonly string[] };

/**
 * The web UI root controllers plugins returned from their `webUi(ctx)`
 * hook, keyed by plugin id. One instance per host process; the webserver
 * picks one per app build ({@link select}) and rebuilds its app whenever
 * the set changes ({@link onChange}), e.g. after a plugin restart.
 */
export class WebUiRegistry {
    private readonly controllers = new Map<string, Hono<WebUiEnv>>();
    private readonly listeners = new Set<() => void>();

    /**
     * Register (or replace) a plugin's root controller.
     *
     * @param pluginId Providing plugin.
     * @param app Its root controller.
     */
    set(pluginId: string, app: Hono<WebUiEnv>): void {
        this.controllers.set(pluginId, app);
        this.notify();
    }

    /**
     * Drop a plugin's controller (plugin restart). No-op when it has none.
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
            const app = this.controllers.get(preferredId);
            return app === undefined
                ? { kind: "notProvided", preferredId, available }
                : { kind: "selected", pluginId: preferredId, app };
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
            app: this.controllers.get(pluginId) as Hono<WebUiEnv>,
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
