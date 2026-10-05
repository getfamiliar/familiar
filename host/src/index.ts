import { createLogger, prettyStdoutStream } from "@getfamiliar/shared";
import { defineCommand, runMain } from "citty";
import { bootstrap, requireHomeDir } from "./Bootstrap.js";
import { configCommand } from "./commands/Config.js";
import { cronCommand } from "./commands/Cron.js";
import { eventsCommand } from "./commands/Events.js";
import { initCommand } from "./commands/Init.js";
import { pluginCommand } from "./commands/Plugin.js";
import { psqlCommand } from "./commands/Psql.js";
import { startCommand } from "./commands/Start.js";
import { stopCommand } from "./commands/Stop.js";
import { buildStorageCommand } from "./commands/Storage.js";
import { toolsCommand } from "./commands/Tools.js";
import { PluginHost } from "./plugins/PluginHost.js";
import { loadPlugins } from "./plugins/PluginLoader.js";

/**
 * Single host CLI entry. Citty parses argv, dispatches to one of the
 * subcommands, and renders `--help` / per-command help. Each subcommand
 * handles its own bootstrap and env requirements.
 *
 * Plugin commands are folded into the root `subCommands` map under
 * each plugin's id (`familiar <plugin-id> <subcommand>`). Building the
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
 * `true` when the CLI runs with uid 0. Postgres and every container run
 * with the operator's uid, so familiar never needs root — and a root run
 * leaves root-owned files in `data/` that break the next normal start.
 *
 * @returns Whether the current process is root (always `false` on
 *   platforms without uids).
 */
function isRunningAsRoot(): boolean {
    return process.getuid?.() === 0;
}

/**
 * Async entry point. Plugins are discovered and imported at runtime
 * (`await loadPlugins`), so the whole startup is async — the plugin list
 * has to exist before `PluginHost.buildSubCommands()` can fold plugin CLI
 * commands into the citty tree. Every command except `init` (and
 * help/version/no-arg introspection) requires an initialized home dir, so
 * that gate runs first with a clear message.
 */
async function main(): Promise<void> {
    if (isRunningAsRoot()) {
        cliLogger.error(
            "familiar must not run as root (e.g. via sudo): files it writes under data/ would end up " +
                "owned by root and become unreadable for the normal daemon. Run it as your own user. " +
                'If a previous root run already left such files, fix them with: sudo chown -R "$(id -u):$(id -g)" data/',
        );
        process.exit(1);
    }
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
                psql: psqlCommand,
                config: configCommand,
                cron: cronCommand,
                tools: toolsCommand,
                plugin: pluginCommand,
                storage: buildStorageCommand(pluginHost),
                ...pluginHost.buildSubCommands(),
            },
        }),
    );
}

void main().catch((err: unknown) => {
    cliLogger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
