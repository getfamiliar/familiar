import { defineCommand, runMain } from "citty";
import { bootstrap } from "./Bootstrap";
import { eventCommand } from "./commands/Event";
import { startCommand } from "./commands/Start";
import { stopCommand } from "./commands/Stop";
import { PluginHost } from "./plugins/PluginHost";

/**
 * Single host CLI entry. Citty parses argv, dispatches to one of the
 * subcommands, and renders `--help` / per-command help. Each subcommand
 * handles its own bootstrap and env requirements.
 *
 * Plugin commands are folded into the root `subCommands` map under
 * each plugin's id (`cli.sh <plugin-id> <subcommand>`). Building the
 * plugin tree calls into each plugin's `commands(ctx)` factory but
 * doesn't open any sockets — the postgres connection is opened
 * lazily on first `ctx.events.emit` and closed after the plugin
 * command's `run()` returns.
 */
const pluginHost = new PluginHost(bootstrap());

runMain(
    defineCommand({
        meta: {
            name: "ea",
            description: "Effective Assistant host CLI",
        },
        subCommands: {
            start: startCommand,
            stop: stopCommand,
            event: eventCommand,
            ...pluginHost.buildSubCommands(),
        },
    }),
);
