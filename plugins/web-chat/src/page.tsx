import type { MountWebPage } from "@getfamiliar/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "@/components/chat";
import { scopeStylesheet } from "@/lib/scoped-style";
import css from "./index.css?inline";

/** Attribute marking the page container; the stylesheet is scoped to it. */
const SCOPE_ATTRIBUTE = "data-familiar-page";

/** Selector of the page container. */
const SCOPE_SELECTOR = `[${SCOPE_ATTRIBUTE}="web-chat"]`;

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
                style.textContent = scopeStylesheet(text, SCOPE_SELECTOR);
            }
        }
    });
}

/**
 * Entry of the chat page: the web UI imports this module and calls the
 * default export with its content area. The page brings its own React
 * root and injects its stylesheet (Tailwind + shadcn theme + typeset)
 * into the document while mounted, scoped to the container (see
 * {@link scopeStylesheet}); the page renders no portals, so everything it
 * shows lives inside that scope.
 *
 * @param container Content area of the web UI.
 * @param context Route prefix, user, navigation.
 * @returns Unmount function.
 */
const mount: MountWebPage = (container, context) => {
    const style = document.createElement("style");
    style.dataset.familiarPage = "web-chat";
    style.textContent = scopeStylesheet(css, SCOPE_SELECTOR);
    container.setAttribute(SCOPE_ATTRIBUTE, "web-chat");
    document.head.append(style);
    mountedStyles.add(style);
    const root = createRoot(container);
    root.render(
        <StrictMode>
            <Chat apiBase={`${context.basePath}/api`} />
        </StrictMode>,
    );
    return () => {
        root.unmount();
        style.remove();
        container.removeAttribute(SCOPE_ATTRIBUTE);
        mountedStyles.delete(style);
    };
};

export default mount;
