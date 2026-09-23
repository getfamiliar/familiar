import { type PluginTool, renderInZone, runJsonTool, ToolError } from "@getfamiliar/shared";
import { readTimezone } from "../Config.js";
import { fetchVehicleData, requireSession, resolveVehicle } from "./ResolveVehicle.js";

/**
 * Build `tesla_location` — where the car is and when that was last
 * established.
 *
 * Reads the same `vehicle_data` rollup as `tesla_info` (and shares its
 * cache), but answers with just the position so the model does not
 * have to wade through the full state for "where is my car".
 *
 * Tesla reports two timestamps in the drive state at *different
 * units*: `gps_as_of` in epoch seconds and `timestamp` in epoch
 * milliseconds. Both are projected into the user's `core.timezone`
 * before they reach the agent, so no downstream surface has to know
 * that.
 *
 * @returns The tool definition.
 */
export function buildLocationTool(): PluginTool<Record<string, never>, object> {
    return {
        name: "location",
        description:
            "Where the default vehicle currently is: latitude, longitude, heading, and the " +
            "local time the GPS fix was taken. Wakes the car if it is asleep, which can take " +
            "up to 30 seconds. If it will not wake, the last known position is returned with " +
            "`from_cache: true` and `cached_at` — say how old it is rather than presenting " +
            "it as current.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        execute: (_args, callCtx) =>
            runJsonTool(async () => {
                const session = requireSession();
                const resolution = await resolveVehicle(session);
                if (resolution.kind === "needs-choice") {
                    return { needs_vehicle_choice: true, message: resolution.message };
                }
                const result = await fetchVehicleData(session, resolution.vehicle);
                const drive = result.data.drive_state;
                if (
                    drive === undefined ||
                    typeof drive.latitude !== "number" ||
                    typeof drive.longitude !== "number"
                ) {
                    throw new ToolError(
                        "NO_LOCATION",
                        "the vehicle data carried no GPS position — the car may have " +
                            "location sharing disabled",
                    );
                }
                const zone = readTimezone(callCtx.host);
                return {
                    vehicle: {
                        id: resolution.vehicle.id,
                        vin: resolution.vehicle.vin,
                        display_name: resolution.vehicle.displayName,
                    },
                    latitude: drive.latitude,
                    longitude: drive.longitude,
                    heading: typeof drive.heading === "number" ? drive.heading : null,
                    shift_state: drive.shift_state ?? null,
                    speed: drive.speed ?? null,
                    // `gps_as_of` is seconds, `timestamp` is milliseconds.
                    gps_fix_at: epochToZone(drive.gps_as_of, 1000, zone),
                    reported_at: epochToZone(drive.timestamp, 1, zone),
                    from_cache: result.fromCache,
                    cached_at:
                        result.cachedAt === null ? null : renderInZone(result.cachedAt, zone),
                };
            }, callCtx.toolRunContext),
    };
}

/**
 * Project one of Tesla's epoch timestamps into the user's timezone.
 *
 * @param value The raw epoch value, in whatever unit the field uses.
 * @param multiplier Factor turning `value` into milliseconds (1000 for seconds, 1 for ms).
 * @param zone IANA zone to render in.
 * @returns A wall-clock ISO string with offset, or `null` when the field was absent.
 */
function epochToZone(value: number | undefined, multiplier: number, zone: string): string | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return null;
    }
    return renderInZone(new Date(value * multiplier).toISOString(), zone);
}
