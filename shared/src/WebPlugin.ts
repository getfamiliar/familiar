/**
 * Plugin pages and controllers of the web UI.
 *
 * A plugin's `webPlugin(ctx)` hook returns a {@link WebPluginUi}: a Hono
 * controller the core webserver mounts at `/plugins/<plugin-id>/`
 * (behind its authentication) and, optionally, a page module the web UI
 * plugin loads into its content area for every browser route under
 * `/plugins/<plugin-id>`.
 */

import type { Hono } from "hono";
import type { AvatarConfig } from "./AssistantAvatar.js";
import type { WebPrincipal, WebUiEnv } from "./WebAuth.js";

/** Where a plugin page's ES module comes from. */
export interface WebPageModule {
    /**
     * Path of the built module relative to the plugin's controller mount,
     * e.g. `page/page.js` → served as `/plugins/<id>/page/page.js` by the
     * plugin's own controller.
     */
    readonly module: string;
    /**
     * Dev mode only: absolute path of the page's source entry (`.tsx`).
     * A web UI with a dev server may load it from source instead (hot
     * reload, one React); omit it in production.
     */
    readonly sourceFile?: string;
}

/** What a plugin hands the core from its `webPlugin(ctx)` hook. */
export interface WebPluginUi {
    /**
     * Controller mounted at `/plugins/<plugin-id>/`, behind the core auth
     * middleware (`c.get("principal")` is set). Register concrete routes
     * only (e.g. `/api/*`, `/page/*`) and **no catch-all**: every path the
     * controller does not match falls through to the web UI, which is how
     * the browser routes of the plugin's page (`/plugins/<id>`, …) reach it.
     */
    readonly controller: Hono<WebUiEnv>;
    /** Optional page shown by the web UI for routes under `/plugins/<plugin-id>`. */
    readonly page?: WebPageModule;
    /**
     * Optional WebSocket endpoints, served at `/plugins/<plugin-id><path>`.
     * The core authenticates every handshake like an ordinary request
     * (proxy login or session, allowlist) and additionally requires a
     * same-origin `Origin` header; only then is `onConnection` called.
     * All sockets of a plugin are closed when it restarts.
     */
    readonly sockets?: readonly WebPluginSocket[];
}

/** A WebSocket endpoint of a plugin (see {@link WebPluginUi.sockets}). */
export interface WebPluginSocket {
    /**
     * Path below the plugin's mount, starting with `/` (e.g. `/socket`
     * → `/plugins/<plugin-id>/socket`). Matched exactly, query ignored.
     */
    readonly path: string;
    /**
     * Called once per authenticated connection. Must not throw; errors
     * of the connection's own work belong on the peer (`close`).
     *
     * @param peer The open socket.
     * @param info Who connected and how.
     */
    onConnection(peer: WebSocketPeer, info: WebSocketConnectionInfo): void;
}

/** Who opened a plugin WebSocket. */
export interface WebSocketConnectionInfo {
    /** The signed-in, allowlisted user. */
    readonly principal: WebPrincipal;
    /** Whether the browser reached the server over HTTPS (directly or via a trusted proxy). */
    readonly isHttps: boolean;
}

/**
 * Minimal, library-independent view of an open WebSocket, so plugins do
 * not depend on the server's WebSocket implementation.
 */
export interface WebSocketPeer {
    /**
     * Send a text (string) or binary (bytes) frame. Silently dropped once
     * the socket is closing.
     *
     * @param data Frame payload.
     */
    send(data: string | Uint8Array): void;
    /**
     * Close the socket.
     *
     * @param code WebSocket close code (default 1000; 4000–4999 are free for the application).
     * @param reason Short human-readable reason (≤ 123 bytes).
     */
    close(code?: number, reason?: string): void;
    /**
     * Register the frame handler (one per peer; a second call replaces it).
     *
     * @param handler Receives text frames as string, binary frames as bytes.
     */
    onMessage(handler: (data: string | Uint8Array) => void): void;
    /**
     * Register the close handler (one per peer; a second call replaces
     * it). Called exactly once, also when the server closed the socket.
     *
     * @param handler Receives the close code and reason.
     */
    onClose(handler: (code: number, reason: string) => void): void;
    /** Bytes queued but not yet sent (for backpressure). */
    readonly bufferedAmount: number;
    /** Whether the socket is open (not connecting, closing or closed). */
    readonly isOpen: boolean;
}

/** A plugin page as the core lists it for the web UI (`ctx.web.listPages()`). */
export interface WebPageEntry {
    /** Plugin providing the page. */
    readonly pluginId: string;
    /** Browser route prefix the page owns: `/plugins/<plugin-id>`. */
    readonly basePath: string;
    /** URL of the built module (`/plugins/<plugin-id>/<module>`). */
    readonly moduleUrl: string;
    /** Dev mode: absolute source entry (see {@link WebPageModule.sourceFile}). */
    readonly sourceFile?: string;
}

/** What the web UI passes to a page module's `mount`. */
export interface WebPageContext {
    /** Route prefix of the page (`/plugins/<plugin-id>`). */
    readonly basePath: string;
    /** Current browser path (at or below `basePath`). */
    readonly pathname: string;
    /** The signed-in user. */
    readonly user: WebPrincipal;
    /** The assistant's name and avatar, as configured (render with `@getfamiliar/avatar`). */
    readonly assistant: WebAssistantIdentity;
    /** Navigate the web UI to another route. */
    navigate(to: string): void;
}

/** How the assistant presents itself in the web UI. */
export interface WebAssistantIdentity {
    /** `core.assistantName`, default `Familiar`. */
    readonly name: string;
    /** `core.assistantAvatar`, completed with defaults. */
    readonly avatar: AvatarConfig;
}

/**
 * Default export of a page module: render the page into `container`
 * (the web UI's content area) and return a function that unmounts it.
 * Framework-agnostic; a React page creates its own root.
 */
export type MountWebPage = (container: HTMLElement, context: WebPageContext) => () => void;

/** Route prefix of a plugin's controller and page. */
export function webPluginBasePath(pluginId: string): string {
    return `/plugins/${pluginId}`;
}
