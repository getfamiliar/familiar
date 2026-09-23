import { type PluginTool, runJsonTool } from "@getfamiliar/shared";
import { fetchVehicleData, requireSession, resolveVehicle } from "./ResolveVehicle.js";

/**
 * Build `tesla_info` — the full `vehicle_data` rollup.
 *
 * The rollup is large (charge, climate, closures, config, GUI
 * settings, …) and routinely exceeds the inline tool budget; wrapping
 * it in `runJsonTool` means an oversized answer spills to
 * `/scratch/<event-id>/` and the agent reads the part it needs with
 * `fs_read` instead of the call failing.
 *
 * @returns The tool definition.
 */
export function buildInfoTool(): PluginTool<Record<string, never>, object> {
    return {
        name: "info",
        description:
            "Full state of the default vehicle: charge level and range, climate, doors and " +
            "windows, odometer, software version, drive state. Wakes the car if it is " +
            "asleep, which can take up to 30 seconds. If the car will not wake, the last " +
            "known state is returned with `from_cache: true` and `cached_at` — mention that " +
            "age to the user instead of presenting it as current. The result is big; it may " +
            "come back as a scratch-file path to read with `fs_read`. For just the position, " +
            "prefer `tesla_location`.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        execute: (_args, callCtx) =>
            runJsonTool(async () => {
                const session = requireSession();
                const resolution = await resolveVehicle(session);
                if (resolution.kind === "needs-choice") {
                    return { needs_vehicle_choice: true, message: resolution.message };
                }
                const result = await fetchVehicleData(session, resolution.vehicle);
                return {
                    vehicle: {
                        id: resolution.vehicle.id,
                        vin: resolution.vehicle.vin,
                        display_name: resolution.vehicle.displayName,
                    },
                    from_cache: result.fromCache,
                    cached_at: result.cachedAt,
                    vehicle_data: result.data,
                };
            }, callCtx.toolRunContext),
    };
}
