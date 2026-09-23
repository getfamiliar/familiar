import type { ConfigService } from "@getfamiliar/shared";

/**
 * Config groups whose world-change bus events (`mail:*`,
 * `calendar:*`) are suppressed on dev instances unless the group's
 * `emitEventsInDev` flag is set.
 */
export type DevEventDomain = "mail" | "calendar";

/**
 * Decide whether a poller-driven bus event of `domain` may be emitted.
 *
 * Production instances always emit. Dev instances (`FAMILIAR_DEV=1`)
 * typically share the production mailbox / calendar, so a fresh dev
 * database would replay the whole backlog as thousands of events; they
 * therefore emit only when `<domain>.emitEventsInDev: true` is set in
 * `config.yml`. The config is read per call so an edit takes effect
 * without a daemon restart.
 *
 * @param config - Host config service.
 * @param domain - Top-level config group the event belongs to.
 * @param devMode - Whether the daemon runs in dev mode (callers pass
 *   `isDevMode()`; injected so tests don't touch `process.env`).
 * @returns `true` when the event should be written to the bus.
 */
export function isEventEmissionAllowed(
    config: ConfigService,
    domain: DevEventDomain,
    devMode: boolean,
): boolean {
    if (!devMode) {
        return true;
    }
    return config.getBool(`${domain}.emitEventsInDev`, false) === true;
}
