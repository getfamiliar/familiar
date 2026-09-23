import type { PluginTool } from "@getfamiliar/shared";
import { buildInfoTool } from "./Info.js";
import { buildInvoicesTool } from "./Invoices.js";
import { buildLocationTool } from "./Location.js";
import { buildSetDefaultVehicleTool } from "./SetDefaultVehicle.js";
import { buildVehiclesListTool } from "./VehiclesList.js";

/**
 * Every tool the Tesla plugin contributes. The host registers each
 * under `tesla_<name>`, and the plugin id doubles as a tool group, so
 * a handler can pull the whole set in with `tools: tesla`.
 *
 * All five are read-only and run at the default tool level. Remote
 * commands (climate, navigation, locks, horn) are deliberately absent:
 * every VCSEC-equipped vehicle rejects unsigned commands, which would
 * require Tesla's `vehicle-command` proxy and a key paired inside the
 * car. See the plugin README.
 *
 * @returns The plugin's tool list.
 */
export function buildTeslaTools(): readonly PluginTool[] {
    return [
        buildVehiclesListTool(),
        buildSetDefaultVehicleTool(),
        buildInfoTool(),
        buildLocationTool(),
        buildInvoicesTool(),
    ];
}
