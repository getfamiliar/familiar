import { type WebPageEntry, type WebPluginUi, webPluginBasePath } from "@getfamiliar/shared";

/** A registered plugin controller with its plugin id. */
export interface RegisteredWebPlugin {
    readonly pluginId: string;
    readonly ui: WebPluginUi;
}

/**
 * The controllers and pages plugins returned from their `webPlugin(ctx)`
 * hook, keyed by plugin id. One instance per host process; the webserver
 * mounts every controller at `/plugins/<plugin-id>` and rebuilds its app
 * when the set changes ({@link onChange}); the web UI plugin lists the
 * pages via `ctx.web.listPages()`.
 */
export class WebPluginRegistry {
    private readonly plugins = new Map<string, WebPluginUi>();
    private readonly listeners = new Set<() => void>();

    /**
     * Register (or replace) a plugin's controller and page.
     *
     * @param pluginId Providing plugin.
     * @param ui Controller and optional page.
     * @throws {Error} When the page module path is absolute or escapes the
     *   plugin's mount (`..`).
     */
    set(pluginId: string, ui: WebPluginUi): void {
        if (ui.page !== undefined) {
            validateModulePath(pluginId, ui.page.module);
        }
        this.plugins.set(pluginId, ui);
        this.notify();
    }

    /**
     * Drop a plugin's controller and page (plugin restart). No-op when it has none.
     *
     * @param pluginId The restarting plugin.
     */
    unregisterPlugin(pluginId: string): void {
        if (this.plugins.delete(pluginId)) {
            this.notify();
        }
    }

    /**
     * All registered controllers, sorted by plugin id.
     *
     * @returns Plugin id and controller per plugin.
     */
    listControllers(): readonly RegisteredWebPlugin[] {
        return [...this.plugins.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([pluginId, ui]) => ({ pluginId, ui }));
    }

    /**
     * The pages, sorted by plugin id.
     *
     * @returns One entry per plugin with a page.
     */
    listPages(): readonly WebPageEntry[] {
        return this.listControllers().flatMap(({ pluginId, ui }) => {
            if (ui.page === undefined) {
                return [];
            }
            const basePath = webPluginBasePath(pluginId);
            const entry: WebPageEntry = {
                pluginId,
                basePath,
                moduleUrl: `${basePath}/${ui.page.module.replace(/^\/+/, "")}`,
                ...(ui.page.sourceFile === undefined ? {} : { sourceFile: ui.page.sourceFile }),
            };
            return [entry];
        });
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

/**
 * Check a page module path: relative to the plugin's mount, no `..`.
 *
 * @param pluginId Plugin (for the message).
 * @param modulePath The path.
 * @throws {Error} When it is empty, absolute or contains `..`.
 */
function validateModulePath(pluginId: string, modulePath: string): void {
    const segments = modulePath.split("/");
    if (modulePath.trim() === "" || /^[a-z]+:/i.test(modulePath) || segments.includes("..")) {
        throw new Error(
            `plugin "${pluginId}" webPlugin: page.module "${modulePath}" must be a path relative to /plugins/${pluginId}/ (e.g. "page/page.js")`,
        );
    }
}
