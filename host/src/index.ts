import { createLogger, prettyStdoutStream } from "@getfamiliar/shared";
import { defineCommand, runMain } from "citty";
import { bootstrap, requireHomeDir } from "./Bootstrap.js";
import { agentrunCommand } from "./commands/Agentrun.js";
import { configCommand } from "./commands/Config.js";
import { cronCommand } from "./commands/Cron.js";
import { eventsCommand } from "./commands/Events.js";
import { initCommand } from "./commands/Init.js";
import { pluginCommand } from "./commands/Plugin.js";
import { psqlCommand } from "./commands/Psql.js";
import { startCommand } from "./commands/Start.js";
import { stopCommand } from "./commands/Stop.js";
import { toolsCommand } from "./commands/Tools.js";
import { loadPlugins } from "./plugins/PluginLoader.js";
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

/**
 * Async entry point. Plugins are discovered and imported at runtime
 * (`await loadPlugins`), so the whole startup is async — the plugin list
 * has to exist before `PluginHost.buildSubCommands()` can fold plugin CLI
 * commands into the citty tree. Every command except `init` (and
 * help/version/no-arg introspection) requires an initialized home dir, so
 * that gate runs first with a clear message.
 */
async function main(): Promise<void> {
    const boot = bootstrap();
    const sub = process.argv[2];
    const needsHome = sub !== undefined && sub !== "init" && !sub.startsWith("-");
    if (needsHome) {
        requireHomeDir(boot);
    }
    const plugins = await loadPlugins(boot, cliLogger);
    const pluginHost = new PluginHost(boot, cliLogger, plugins);
    runMain(
        defineCommand({
            meta: {
                name: "familiar",
                description: "Familiar host CLI",
            },
            subCommands: {
                init: initCommand,
                start: startCommand,
                stop: stopCommand,
                events: eventsCommand,
                agentrun: agentrunCommand,
                psql: psqlCommand,
                config: configCommand,
                cron: cronCommand,
                tools: toolsCommand,
                plugin: pluginCommand,
                ...pluginHost.buildSubCommands(),
            },
        }),
    );
}

void main().catch((err: unknown) => {
    cliLogger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
