import type { MountWebPage } from "@getfamiliar/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CallScreen } from "@/components/call-screen";
import { scopeStylesheet } from "@/lib/scoped-style";
import css from "./index.css?inline";

/** Attribute marking the page container; the stylesheet is scoped to it. */
const SCOPE_ATTRIBUTE = "data-familiar-page";

/** Selector of the page container. */
const SCOPE_SELECTOR = `[${SCOPE_ATTRIBUTE}="gpt-voice"]`;

/** Style elements of the mounted pages (normally one). */
const mountedStyles = new Set<HTMLStyleElement>();

// Dev mode: swap the regenerated Tailwind CSS in place instead of letting
// the update reload the web UI (which would drop a running call).
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
 * Entry of the voice page: the web UI imports this module and calls the
 * default export with its content area. Like the chat page it brings its
 * own React root and a stylesheet scoped to the container, and renders
 * no portals.
 *
 * @param container Content area of the web UI.
 * @param context Route prefix, user, assistant identity, navigation.
 * @returns Unmount function (ends a running call).
 */
const mount: MountWebPage = (container, context) => {
    const style = document.createElement("style");
    style.dataset.familiarPage = "gpt-voice";
    style.textContent = scopeStylesheet(css, SCOPE_SELECTOR);
    container.setAttribute(SCOPE_ATTRIBUTE, "gpt-voice");
    document.head.append(style);
    mountedStyles.add(style);
    const root = createRoot(container);
    root.render(
        <StrictMode>
            <CallScreen basePath={context.basePath} assistant={context.assistant} />
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
