import { definePlugin } from "@getfamiliar/shared";
import { buildCommands } from "./Commands.js";
import { startTailscaleDaemon, stopTailscaleDaemon } from "./TailscaleDaemon.js";

/**
 * Tailscale host-side plugin.
 *
 * Publishes the familiar web UI in the user's tailnet through a
 * dedicated Tailscale node running as the `familiar-tailscale` docker
 * sidecar in userspace networking mode. The node serves HTTPS :443 →
 * the core webserver and nothing else: the host machine itself does
 * not join the tailnet, no routes, DNS, SSH or exit-node features are
 * enabled.
 *
 * Self-disables (logs a warning) when `webserver.enabled` is not true.
 * The webserver keys are captured at start, so they restart the plugin
 * on a config reload.
 */
export default definePlugin({
    id: "tailscale",
    host: {
        restartOnConfigChange: ["webserver.enabled", "webserver.port", "webserver.host"],
        start: (ctx) => startTailscaleDaemon(ctx),
        stop: () => stopTailscaleDaemon(),
        commands: (ctx) => buildCommands(ctx),
    },
});
