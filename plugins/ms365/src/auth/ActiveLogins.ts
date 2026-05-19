import type { LoginStore } from "./LoginStore.js";

/**
 * Module-scoped pointer to the live {@link LoginStore} once the
 * Ms365 daemon has wired one up. Plugin tools resolve their UPN →
 * {@link import("./GraphAuth.js").GraphAuth} lookup through this so
 * they don't have to drag a provider reference through their
 * `execute` calls.
 *
 * The plugin lifecycle guarantees `start(ctx)` (which calls
 * {@link setActiveLogins}) runs before the host registers `tools(ctx)`,
 * so any tool invocation that fires a real event has a populated
 * store. Tools fall back to a clear error if the store isn't set —
 * typically only on the never-logged-in path.
 */
let activeLogins: LoginStore | null = null;

export function setActiveLogins(store: LoginStore): void {
    activeLogins = store;
}

export function getActiveLogins(): LoginStore | null {
    return activeLogins;
}
