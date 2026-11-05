import type { MountWebPage } from "@getfamiliar/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "@/components/chat";
import { TooltipProvider } from "@/components/ui/tooltip";
import css from "./index.css?inline";

/** Style elements of the mounted pages (normally one). */
const mountedStyles = new Set<HTMLStyleElement>();

// Dev mode: Tailwind regenerates this CSS on every source change. Swap the
// text in place instead of letting the update bubble up to the web UI
// (which would reload the page and lose the chat state).
if (import.meta.hot) {
    import.meta.hot.accept("./index.css?inline", (next) => {
        const text = (next as { default?: string } | undefined)?.default;
        if (text !== undefined) {
            for (const style of mountedStyles) {
                style.textContent = text;
            }
        }
    });
}

/**
 * Entry of the chat page: the web UI imports this module and calls the
 * default export with its content area. The page brings its own React
 * root and injects its stylesheet (Tailwind + shadcn theme + typeset)
 * into the document while mounted.
 *
 * @param container Content area of the web UI.
 * @param context Route prefix, user, navigation.
 * @returns Unmount function.
 */
const mount: MountWebPage = (container, context) => {
    const style = document.createElement("style");
    style.dataset.familiarPage = "web-chat";
    style.textContent = css;
    document.head.append(style);
    mountedStyles.add(style);
    const root = createRoot(container);
    root.render(
        <StrictMode>
            <TooltipProvider>
                <Chat apiBase={`${context.basePath}/api`} />
            </TooltipProvider>
        </StrictMode>,
    );
    return () => {
        root.unmount();
        style.remove();
        mountedStyles.delete(style);
    };
};

export default mount;
