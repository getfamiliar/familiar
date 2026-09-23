import { markdownTable, ToolError } from "@getfamiliar/shared";
import type { TeslaVehicle, VehicleData } from "../api/OwnerApiClient.js";
import { TeslaApiError } from "../api/TeslaApiError.js";
import { getActiveSession, type TeslaSession } from "../auth/ActiveSession.js";

/** How often the wake-up poll re-checks the vehicle's state. */
const WAKE_POLL_INTERVAL_MS = 2_000;

/**
 * Outcome of picking the vehicle a tool should act on.
 *
 * `needs-choice` is **not** an error: the account holds several cars
 * and none is remembered yet, so the agent is expected to show the
 * list, ask the user, and call `tesla_set_default_vehicle`. Modelling
 * that as a `ToolError` would read to the model as a failure to
 * recover from rather than a question to pass on.
 */
export type VehicleResolution =
    | { readonly kind: "vehicle"; readonly vehicle: TeslaVehicle }
    | { readonly kind: "needs-choice"; readonly message: string };

/** A `vehicle_data` rollup plus how fresh it is. */
export interface VehicleDataResult {
    readonly data: VehicleData;
    /** True when the car would not wake and the last-known state was used. */
    readonly fromCache: boolean;
    /** ISO instant the cached copy was taken; `null` for a live fetch. */
    readonly cachedAt: string | null;
}

/**
 * Fetch the live session the daemon published, or fail with a message
 * that names the fix.
 *
 * @returns The active session.
 * @throws {ToolError} When the daemon never started one (no login).
 */
export function requireSession(): TeslaSession {
    const session = getActiveSession();
    if (session === null) {
        throw new ToolError(
            "NO_TESLA_LOGIN",
            "no Tesla login is active; run `familiar tesla login` and restart the daemon",
        );
    }
    return session;
}

/**
 * Decide which vehicle a tool acts on.
 *
 * Reads the remembered default first. When none is set, lists the
 * account's vehicles: exactly one is adopted silently (there is
 * nothing to ask), several produce a `needs-choice` result carrying
 * the table the agent should show the user.
 *
 * A remembered vehicle that no longer exists on the account is treated
 * as unset, so swapping cars self-heals instead of failing forever.
 *
 * @param session The active session.
 * @returns Either the chosen vehicle or a request for the user to choose.
 * @throws {ToolError} When the account holds no vehicles at all.
 */
export async function resolveVehicle(session: TeslaSession): Promise<VehicleResolution> {
    const vehicles = await session.owner.listVehicles();
    if (vehicles.length === 0) {
        throw new ToolError("NO_VEHICLES", "this Tesla account has no vehicles on it");
    }

    const remembered = await session.defaults.read();
    if (remembered !== null) {
        const match = vehicles.find((v) => v.id === remembered.id);
        if (match !== undefined) {
            return { kind: "vehicle", vehicle: match };
        }
    }

    if (vehicles.length === 1) {
        const only = vehicles[0];
        await session.defaults.write({
            id: only.id,
            vin: only.vin,
            displayName: only.displayName,
        });
        return { kind: "vehicle", vehicle: only };
    }

    return { kind: "needs-choice", message: renderChoicePrompt(vehicles) };
}

/**
 * Build the explanation the agent passes on when several vehicles are
 * available and none is remembered.
 *
 * @param vehicles Every vehicle on the account.
 * @returns Markdown: one sentence of instruction plus the vehicle table.
 */
export function renderChoicePrompt(vehicles: readonly TeslaVehicle[]): string {
    const table = markdownTable(
        ["id", "vin", "name", "state"],
        vehicles.map((v) => [v.id, v.vin, v.displayName, v.state]),
    );
    return (
        `This Tesla account has ${vehicles.length} vehicles and none is set as the default ` +
        "yet, so I cannot tell which one you mean. Ask the user which car to use, then call " +
        "`tesla_set_default_vehicle` with its `id`. Every later Tesla tool call will then " +
        `use that car until it is changed.\n\n${table}`
    );
}

/**
 * Get a vehicle's state rollup, waking the car first when it is
 * asleep.
 *
 * Wakes with `wake_up` and polls the vehicle's `state` every two
 * seconds until it reports `online` or
 * {@link import("../Config.js").TeslaConfig.wakeTimeoutSeconds} passes.
 * On timeout — or when an awake-looking car still answers `408 vehicle
 * unavailable` — the last successful rollup is returned with
 * `fromCache: true` so the agent can say how old the answer is.
 *
 * Every live fetch refreshes the cache.
 *
 * @param session The active session.
 * @param vehicle The vehicle to read.
 * @returns The rollup plus its freshness.
 * @throws {ToolError} When the car would not wake and nothing is cached.
 */
export async function fetchVehicleData(
    session: TeslaSession,
    vehicle: TeslaVehicle,
): Promise<VehicleDataResult> {
    // The list's `state` is a snapshot that can already be stale, so an
    // "online" car may still answer 408. Try the cheap read first in
    // that case, but fall through to a real wake rather than giving up
    // on a cached answer the user would have to be told is old.
    if (vehicle.state === "online") {
        const live = await tryLiveRead(session, vehicle.id);
        if (live !== null) {
            return live;
        }
    }
    if (await wakeVehicle(session, vehicle.id)) {
        const live = await tryLiveRead(session, vehicle.id);
        if (live !== null) {
            return live;
        }
    }

    const cached = await session.cache.read(vehicle.id);
    if (cached === null) {
        throw new ToolError(
            "VEHICLE_ASLEEP",
            `${describeVehicle(vehicle)} did not wake within ` +
                `${session.config.wakeTimeoutSeconds}s and no earlier data is cached for it`,
        );
    }
    return {
        data: cached.data,
        fromCache: true,
        cachedAt: new Date(cached.fetchedAt).toISOString(),
    };
}

/**
 * Attempt one live `vehicle_data` read, refreshing the cache on
 * success.
 *
 * @param session The active session.
 * @param vehicleId The vehicle's `id_s`.
 * @returns The live result, or `null` when the car turned out to be
 *   unavailable (the caller decides whether to wake or fall back).
 * @throws Any error other than "vehicle unavailable" — a bad token or a
 *   broken endpoint must not be silently reported as a sleeping car.
 */
async function tryLiveRead(
    session: TeslaSession,
    vehicleId: string,
): Promise<VehicleDataResult | null> {
    try {
        const data = await session.owner.getVehicleData(vehicleId);
        await session.cache.write(vehicleId, data);
        return { data, fromCache: false, cachedAt: null };
    } catch (err) {
        if (err instanceof TeslaApiError && err.isVehicleUnavailable) {
            return null;
        }
        throw err;
    }
}

/**
 * Wake a sleeping vehicle and wait for it to come online.
 *
 * @param session The active session.
 * @param vehicleId The vehicle's `id_s`.
 * @returns True when the car reported `online` inside the timeout.
 */
async function wakeVehicle(session: TeslaSession, vehicleId: string): Promise<boolean> {
    const deadline = Date.now() + session.config.wakeTimeoutSeconds * 1000;
    try {
        const woken = await session.owner.wakeUp(vehicleId);
        if (woken.state === "online") {
            return true;
        }
    } catch (err) {
        if (!(err instanceof TeslaApiError) || !err.isVehicleUnavailable) {
            throw err;
        }
    }
    while (Date.now() < deadline) {
        await sleep(Math.min(WAKE_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
        try {
            const current = await session.owner.getVehicle(vehicleId);
            if (current.state === "online") {
                return true;
            }
        } catch (err) {
            if (!(err instanceof TeslaApiError) || !err.isVehicleUnavailable) {
                throw err;
            }
        }
    }
    return false;
}

/**
 * Name a vehicle for an error message, preferring its display name.
 *
 * @param vehicle The vehicle to describe.
 * @returns A short human-readable label.
 */
export function describeVehicle(vehicle: TeslaVehicle): string {
    return vehicle.displayName.length > 0 ? vehicle.displayName : `vehicle ${vehicle.id}`;
}

/**
 * Promise-based delay.
 *
 * @param ms Milliseconds to wait.
 * @returns A promise resolving after the delay.
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
