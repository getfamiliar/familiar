import type {
    AvatarConfig,
    WebAssistantIdentity,
    WebMenuEntry,
    WebPageEntry,
    WebPrincipal,
} from "@getfamiliar/shared";
import { useCallback, useEffect, useState } from "react";

/** What the app shell needs from the server (`GET /api/shell`). */
export interface Shell {
    /** The signed-in user, as the core webserver resolved it. */
    readonly user: WebPrincipal;
    /** The assistant's name and avatar. */
    readonly assistant: WebAssistantIdentity;
    /** Version of the running familiar host. */
    readonly version: string;
    /** Sidebar menu contributed by the plugins, already sorted. */
    readonly menu: readonly WebMenuEntry[];
    /** Pages plugins provide, each owning the routes under its `basePath`. */
    readonly pages: readonly WebPageEntry[];
}

/** The shell data plus the one change the UI makes to it. */
export interface ShellState {
    /** The shell data, or null while loading or on error. */
    readonly shell: Shell | null;
    /** Show a newly saved avatar everywhere (brand, favicon, plugin pages). */
    readonly setAssistantAvatar: (avatar: AvatarConfig) => void;
}

/**
 * Load the shell data once. A 401 (session expired) sends the browser to
 * the core login page.
 *
 * @returns The shell data and its updater.
 */
export function useShell(): ShellState {
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
    const setAssistantAvatar = useCallback((avatar: AvatarConfig) => {
        setShell((current) =>
            current === null ? null : { ...current, assistant: { ...current.assistant, avatar } },
        );
    }, []);
    return { shell, setAssistantAvatar };
}
