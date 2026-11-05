import type { MountWebPage, WebPageEntry, WebPrincipal } from "@getfamiliar/shared";
import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Find the plugin page owning `pathname`: the longest `basePath` that is
 * the path itself or a prefix followed by `/`.
 *
 * @param pages Pages from `/api/shell`.
 * @param pathname Current `location.pathname`.
 * @returns The page, or null.
 */
export function findPluginPage(
    pages: readonly WebPageEntry[],
    pathname: string,
): WebPageEntry | null {
    let best: WebPageEntry | null = null;
    for (const page of pages) {
        const owns = pathname === page.basePath || pathname.startsWith(`${page.basePath}/`);
        if (owns && page.basePath.length > (best?.basePath.length ?? -1)) {
            best = page;
        }
    }
    return best;
}

/**
 * URL to import a page module from. In dev mode, a page that names its
 * source entry is loaded through this web UI's Vite server (`/@fs/…`),
 * so it shares React and gets hot reloading; otherwise the plugin's
 * built module.
 *
 * @param page The page.
 * @returns The module URL.
 */
function moduleUrlOf(page: WebPageEntry): string {
    if (import.meta.env.DEV && page.sourceFile !== undefined) {
        return `/@fs${page.sourceFile}`;
    }
    return page.moduleUrl;
}

/**
 * Content area of a plugin page: loads the page's ES module and lets it
 * render into a container (`mount(container, context)`), unmounting it
 * on change. Shows a spinner while loading and the error when the module
 * fails.
 *
 * @param props.page The page owning the current route.
 * @param props.pathname Current browser path.
 * @param props.user The signed-in user.
 * @returns The container.
 */
export function PluginPage({
    page,
    pathname,
    user,
}: {
    readonly page: WebPageEntry;
    readonly pathname: string;
    readonly user: WebPrincipal;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [state, setState] = useState<"loading" | "mounted" | { error: string }>("loading");

    useEffect(() => {
        const container = containerRef.current;
        if (container === null) {
            return;
        }
        let unmount: (() => void) | null = null;
        let isCancelled = false;
        setState("loading");
        import(/* @vite-ignore */ moduleUrlOf(page))
            .then((module: { default?: MountWebPage }) => {
                if (isCancelled) {
                    return;
                }
                if (typeof module.default !== "function") {
                    throw new Error(
                        `${page.moduleUrl} has no default export mount(container, context)`,
                    );
                }
                unmount = module.default(container, {
                    basePath: page.basePath,
                    pathname,
                    user,
                    navigate: (to) => window.location.assign(to),
                });
                setState("mounted");
            })
            .catch((err: unknown) => {
                if (!isCancelled) {
                    setState({ error: err instanceof Error ? err.message : String(err) });
                }
            });
        return () => {
            isCancelled = true;
            unmount?.();
        };
    }, [page, pathname, user]);

    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            {state === "loading" && (
                <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                    <LoaderCircleIcon className="size-5 animate-spin" />
                </div>
            )}
            {typeof state === "object" && (
                <div className="m-4 flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
                    <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <div>
                        <p className="font-medium">
                            The page of plugin "{page.pluginId}" failed to load.
                        </p>
                        <p className="text-muted-foreground">{state.error}</p>
                    </div>
                </div>
            )}
            <div ref={containerRef} className="flex min-h-0 flex-1 flex-col" />
        </div>
    );
}
