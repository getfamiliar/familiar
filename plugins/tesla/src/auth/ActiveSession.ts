import type { OwnerApiClient } from "../api/OwnerApiClient.js";
import type { OwnershipClient } from "../api/OwnershipClient.js";
import type { TeslaConfig } from "../Config.js";
import type { DefaultVehicleStore } from "../state/DefaultVehicleStore.js";
import type { VehicleDataCache } from "../state/VehicleDataCache.js";
import type { TeslaAuth } from "./TeslaAuth.js";

/**
 * Everything a tool needs to talk to Tesla, assembled once by the
 * daemon.
 */
export interface TeslaSession {
    readonly auth: TeslaAuth;
    readonly owner: OwnerApiClient;
    readonly ownership: OwnershipClient;
    readonly defaults: DefaultVehicleStore;
    readonly cache: VehicleDataCache;
    readonly config: TeslaConfig;
}

/**
 * Module-scoped pointer to the live {@link TeslaSession} once
 * {@link import("../TeslaDaemon.js").startTeslaDaemon} has wired one
 * up. Plugin tools resolve their clients through this instead of
 * dragging a reference through every `execute` signature — the same
 * pattern as ms365's `ActiveLogins`.
 *
 * The plugin lifecycle guarantees `start(ctx)` (which calls
 * {@link setActiveSession}) runs before the host collects `tools(ctx)`,
 * so any real tool invocation sees a populated session. Tools still
 * fall back to a clear error when it is `null`, which in practice only
 * happens on the never-logged-in path.
 */
let activeSession: TeslaSession | null = null;

/**
 * Publish the session the daemon built.
 *
 * @param session The assembled session.
 */
export function setActiveSession(session: TeslaSession): void {
    activeSession = session;
}

/**
 * Read the published session.
 *
 * @returns The session, or `null` when the daemon never started one.
 */
export function getActiveSession(): TeslaSession | null {
    return activeSession;
}
