import { type PluginTool, runJsonTool } from "@getfamiliar/shared";
import { requireSession } from "./ResolveVehicle.js";

/**
 * Build `tesla_vehicles_list` — the account's vehicles with the id
 * every other Tesla tool keys on.
 *
 * Deliberately does not wake anything: the list endpoint answers for
 * sleeping cars too, and the reported `state` is what tells the agent
 * whether the next call will need a (slow) wake-up.
 *
 * @returns The tool definition.
 */
export function buildVehiclesListTool(): PluginTool<Record<string, never>, object> {
    return {
        name: "vehicles_list",
        description:
            "List the vehicles on the connected Tesla account with their id, VIN, display " +
            "name and current state (`online`, `asleep`, `offline`). The `id` is what " +
            "`tesla_set_default_vehicle` expects. Does not wake any vehicle, so it is always " +
            "fast and safe to call.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        execute: (_args, callCtx) =>
            runJsonTool(async () => {
                const session = requireSession();
                const vehicles = await session.owner.listVehicles();
                const current = await session.defaults.read();
                return {
                    vehicles: vehicles.map((v) => ({
                        id: v.id,
                        vin: v.vin,
                        display_name: v.displayName,
                        state: v.state,
                        is_default: current !== null && current.id === v.id,
                    })),
                };
            }, callCtx.toolRunContext),
    };
}
