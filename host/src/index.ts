import { defineCommand, runMain } from "citty";
import { createLogger, prettyStdoutStream } from "effective-assistant-shared";
import { bootstrap } from "./Bootstrap.js";
import { agentrunCommand } from "./commands/Agentrun.js";
import { configCommand } from "./commands/Config.js";
import { eventCommand } from "./commands/Event.js";
import { mcpCommand } from "./commands/Mcp.js";
import { psqlCommand } from "./commands/Psql.js";
import { reportCommand } from "./commands/Report.js";
import { startCommand } from "./commands/Start.js";
import { stopCommand } from "./commands/Stop.js";
import { PluginHost } from "./plugins/PluginHost.js";

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
// One-shot CLI commands (anything other than `start`) get a simple
// pretty-stdout logger. The `start` daemon builds its own logger
// inside its `run()` handler so it can include the rolling file sink.
const cliLogger = createLogger({
    component: "cli",
    level: "info",
    streams: [prettyStdoutStream()],
});
const pluginHost = new PluginHost(bootstrap(), cliLogger);

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
            agentrun: agentrunCommand,
            psql: psqlCommand,
            config: configCommand,
            mcp: mcpCommand,
            report: reportCommand,
            ...pluginHost.buildSubCommands(),
        },
    }),
);
