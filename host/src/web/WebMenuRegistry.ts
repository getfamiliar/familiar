import {
    WEB_MENU_ICON_PATTERN,
    type WebMenuContribution,
    type WebMenuEntry,
    type WebMenuItem,
} from "@getfamiliar/shared";

/** A validated contribution of one plugin. */
interface StoredContribution {
    readonly weight: number;
    readonly items: readonly WebMenuItem[];
}

/**
 * The web UI menu items plugins contribute through their `webMenu(ctx)`
 * hook, keyed by plugin id. One instance per host process; read by the
 * web UI plugin via `ctx.web.listMenuItems()` on every request.
 */
export class WebMenuRegistry {
    private readonly contributions = new Map<string, StoredContribution>();

    /**
     * Register (or replace) a plugin's contribution after validating it.
     *
     * @param pluginId Contributing plugin.
     * @param contribution Its items and weight.
     * @throws {Error} When an item is malformed; the message names the
     *   plugin, the item and the problem. Nothing is stored then.
     */
    set(pluginId: string, contribution: WebMenuContribution): void {
        const weight = contribution.weight ?? 0;
        if (!Number.isFinite(weight)) {
            throw new Error(`plugin "${pluginId}" webMenu: weight must be a finite number`);
        }
        contribution.items.forEach((item, index) => {
            validateItem(pluginId, index, item);
        });
        this.contributions.set(pluginId, { weight, items: [...contribution.items] });
    }

    /**
     * Drop a plugin's contribution (plugin restart). No-op when it has none.
     *
     * @param pluginId The restarting plugin.
     */
    unregisterPlugin(pluginId: string): void {
        this.contributions.delete(pluginId);
    }

    /**
     * All items, sorted by plugin weight (ascending), then plugin id; each
     * plugin's items keep their order.
     *
     * @returns The flat list, each item tagged with its plugin id.
     */
    list(): readonly WebMenuEntry[] {
        return [...this.contributions.entries()]
            .sort(([idA, a], [idB, b]) => a.weight - b.weight || idA.localeCompare(idB))
            .flatMap(([pluginId, { items }]) => items.map((item) => ({ ...item, pluginId })));
    }
}

/**
 * Check one item.
 *
 * @param pluginId Contributing plugin (for the message).
 * @param index Item position (for the message).
 * @param item The item.
 * @throws {Error} When the icon id, a label or a route is invalid, or the
 *   item has neither a route nor children.
 */
function validateItem(pluginId: string, index: number, item: WebMenuItem): void {
    const where = `plugin "${pluginId}" webMenu item ${index} ("${item.label}")`;
    if (typeof item.label !== "string" || item.label.trim() === "") {
        throw new Error(`plugin "${pluginId}" webMenu item ${index}: label must not be empty`);
    }
    if (typeof item.icon !== "string" || !WEB_MENU_ICON_PATTERN.test(item.icon)) {
        throw new Error(
            `${where}: icon "${String(item.icon)}" is not a lucide icon id (kebab-case, e.g. "calendar-days")`,
        );
    }
    if (item.route !== undefined) {
        validateRoute(where, item.route);
    }
    const children = item.children ?? [];
    if (item.route === undefined && children.length === 0) {
        throw new Error(`${where}: needs a route or children`);
    }
    children.forEach((child, childIndex) => {
        if (typeof child.label !== "string" || child.label.trim() === "") {
            throw new Error(`${where}: child ${childIndex} has an empty label`);
        }
        validateRoute(`${where}, child "${child.label}"`, child.route);
    });
}

/**
 * Check a route: a path inside the web UI.
 *
 * @param where Message prefix.
 * @param route The route.
 * @throws {Error} When it does not start with a single `/`.
 */
function validateRoute(where: string, route: string): void {
    if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")) {
        throw new Error(`${where}: route "${String(route)}" must be a path starting with "/"`);
    }
}
