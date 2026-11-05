import type { WebMenuEntry } from "@getfamiliar/shared";

/**
 * Whether `route` is the current page or one of its sub-pages.
 *
 * @param route Menu route.
 * @param pathname Current `location.pathname`.
 * @returns True when active.
 */
export function isRouteActive(route: string | undefined, pathname: string): boolean {
    if (route === undefined) {
        return false;
    }
    if (route === "/") {
        return pathname === "/";
    }
    return pathname === route || pathname.startsWith(`${route.replace(/\/+$/, "")}/`);
}

/** The menu position of the current page, for the breadcrumb. */
export interface ActiveMenuPath {
    /** Top-level item label. */
    readonly item: string;
    /** Sub-entry label, when a child matched. */
    readonly child?: string;
}

/**
 * Find the menu entry of the current page; the most specific (longest)
 * matching route wins.
 *
 * @param menu Sorted menu items.
 * @param pathname Current `location.pathname`.
 * @returns The labels, or null when no route matches.
 */
export function findActiveMenuPath(
    menu: readonly WebMenuEntry[],
    pathname: string,
): ActiveMenuPath | null {
    let best: { path: ActiveMenuPath; length: number } | null = null;
    const consider = (route: string | undefined, path: ActiveMenuPath) => {
        if (
            route !== undefined &&
            isRouteActive(route, pathname) &&
            route.length > (best?.length ?? -1)
        ) {
            best = { path, length: route.length };
        }
    };
    for (const item of menu) {
        consider(item.route, { item: item.label });
        for (const child of item.children ?? []) {
            consider(child.route, { item: item.label, child: child.label });
        }
    }
    return (best as { path: ActiveMenuPath } | null)?.path ?? null;
}
