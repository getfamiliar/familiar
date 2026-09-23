import { type PluginTool, runJsonTool, ToolError } from "@getfamiliar/shared";
import { requireSession } from "./ResolveVehicle.js";

/** Args accepted by `tesla_set_default_vehicle`. */
export interface SetDefaultVehicleArgs {
    readonly id?: string;
}

/**
 * Build `tesla_set_default_vehicle` — remember which car the other
 * Tesla tools act on.
 *
 * The id is validated against the live vehicle list rather than taken
 * on faith, so a typo fails here with the available choices instead of
 * surfacing as a confusing 404 on the next unrelated tool call.
 *
 * @returns The tool definition.
 */
export function buildSetDefaultVehicleTool(): PluginTool<SetDefaultVehicleArgs, object> {
    return {
        name: "set_default_vehicle",
        description:
            "Choose which vehicle every other Tesla tool acts on, by its `id` from " +
            "`tesla_vehicles_list`. The choice persists until it is changed again. When the " +
            "account holds only one vehicle you never need this — it is adopted " +
            "automatically.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["id"],
            properties: {
                id: {
                    type: "string",
                    description: "Vehicle id as reported by `tesla_vehicles_list`.",
                },
            },
        },
        execute: (args, callCtx) =>
            runJsonTool(async () => {
                const id = args.id;
                if (typeof id !== "string" || id.trim().length === 0) {
                    throw new ToolError(
                        "INVALID_ARGUMENT",
                        "`id` is required and must be a non-empty vehicle id",
                    );
                }
                const session = requireSession();
                const vehicles = await session.owner.listVehicles();
                const match = vehicles.find((v) => v.id === id.trim());
                if (match === undefined) {
                    throw new ToolError(
                        "UNKNOWN_VEHICLE",
                        `no vehicle with id ${id.trim()} on this account; available ids: ` +
                            vehicles.map((v) => `${v.id} (${v.displayName})`).join(", "),
                    );
                }
                await session.defaults.write({
                    id: match.id,
                    vin: match.vin,
                    displayName: match.displayName,
                });
                return {
                    default_vehicle: {
                        id: match.id,
                        vin: match.vin,
                        display_name: match.displayName,
                    },
                };
            }, callCtx.toolRunContext),
    };
}
