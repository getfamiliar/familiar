import { defineCommand, runMain } from "citty";
import { eventCommand } from "./commands/Event";
import { startCommand } from "./commands/Start";
import { stopCommand } from "./commands/Stop";

/**
 * Single host CLI entry. Citty parses argv, dispatches to one of the
 * subcommands, and renders `--help` / per-command help. Each subcommand
 * handles its own bootstrap and env requirements.
 */
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
        },
    }),
);
