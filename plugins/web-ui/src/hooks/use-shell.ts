import type { WebMenuEntry, WebPageEntry, WebPrincipal } from "@getfamiliar/shared";
import { useEffect, useState } from "react";

/** What the app shell needs from the server (`GET /api/shell`). */
export interface Shell {
    /** The signed-in user, as the core webserver resolved it. */
    readonly user: WebPrincipal;
    /** Version of the running familiar host. */
    readonly version: string;
    /** Sidebar menu contributed by the plugins, already sorted. */
    readonly menu: readonly WebMenuEntry[];
    /** Pages plugins provide, each owning the routes under its `basePath`. */
    readonly pages: readonly WebPageEntry[];
}

/**
 * Load the shell data once. A 401 (session expired) sends the browser to
 * the core login page.
 *
 * @returns The shell data, or null while loading or on error.
 */
export function useShell(): Shell | null {
    const [shell, setShell] = useState<Shell | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        fetch("/api/shell", { signal: controller.signal, headers: { accept: "application/json" } })
            .then(async (res) => {
                if (res.status === 401) {
                    window.location.assign("/login");
                    return;
                }
                if (!res.ok) {
                    throw new Error(`GET /api/shell answered ${res.status}`);
                }
                setShell((await res.json()) as Shell);
            })
            .catch((err: unknown) => {
                if (!controller.signal.aborted) {
                    console.error("could not load the app shell", err);
                }
            });
        return () => controller.abort();
    }, []);
    return shell;
}
