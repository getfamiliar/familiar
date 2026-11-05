/**
 * Navigation entries plugins contribute to the web UI's sidebar.
 *
 * A plugin returns one {@link WebMenuContribution} from its `webMenu(ctx)`
 * hook; the core collects them, sorts them by weight and hands the flat
 * list to the web UI plugin (`ctx.web.listMenuItems()`), which renders it.
 */

/** Lucide icon id, kebab-case (`mail`, `calendar-days`), see https://lucide.dev/icons. */
export const WEB_MENU_ICON_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A sub-entry of a collapsible menu item. */
export interface WebMenuSubItem {
    /** Text shown in the menu. */
    readonly label: string;
    /** Path inside the web UI, starting with `/` (e.g. `/plugins/mail/inbox`). */
    readonly route: string;
}

/**
 * One top-level menu item: a direct link (`route` without `children`) or a
 * collapsible group (`children`, optionally with its own `route`).
 */
export interface WebMenuItem {
    /** Lucide icon id (see {@link WEB_MENU_ICON_PATTERN}). */
    readonly icon: string;
    /** Text shown in the menu. */
    readonly label: string;
    /** Path inside the web UI, starting with `/`. Required when there are no children. */
    readonly route?: string;
    /** Sub-entries; makes the item collapsible. */
    readonly children?: readonly WebMenuSubItem[];
}

/** What one plugin contributes to the menu. */
export interface WebMenuContribution {
    /**
     * Position of the plugin's items among all plugins: lower weights come
     * first (default 0; ties are ordered by plugin id). The plugin's items
     * keep their own order.
     */
    readonly weight?: number;
    /** The plugin's items, in display order. */
    readonly items: readonly WebMenuItem[];
}

/** A menu item as the core hands it to the web UI. */
export interface WebMenuEntry extends WebMenuItem {
    /** Plugin that contributed the item. */
    readonly pluginId: string;
}

/**
 * The first route of a menu: the first item's own route, else its first
 * child's route. The web UI opens it instead of an empty start page.
 *
 * @param items Sorted menu items.
 * @returns The route, or null for an empty menu.
 */
export function firstMenuRoute(items: readonly WebMenuItem[]): string | null {
    const first = items[0];
    if (first === undefined) {
        return null;
    }
    return first.route ?? first.children?.[0]?.route ?? null;
}
