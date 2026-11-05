import { definePlugin } from "@getfamiliar/shared";
import { buildCommands } from "./Commands.js";
import {
    registerTrustedProxy,
    startTailscaleDaemon,
    stopTailscaleDaemon,
} from "./TailscaleDaemon.js";

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
 * The node does not talk to the webserver directly: a Caddy proxy in the
 * sidecar's network namespace adds the plugin's trusted-proxy secret,
 * which `prepare` registers via `ctx.web.registerTrustedProxy`, so the
 * webserver trusts the `Tailscale-User-*` headers only on those requests.
 *
 * Self-disables (logs a warning) when `webserver.enabled` is not true.
 * The webserver keys are captured at start, so they restart the plugin
 * on a config reload.
 */
export default definePlugin({
    id: "tailscale",
    host: {
        restartOnConfigChange: ["webserver.enabled", "webserver.port", "webserver.host"],
        prepare: (ctx) => registerTrustedProxy(ctx),
        start: (ctx) => startTailscaleDaemon(ctx),
        stop: () => stopTailscaleDaemon(),
        commands: (ctx) => buildCommands(ctx),
    },
});
