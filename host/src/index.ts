import { defineCommand, runMain } from "citty";
import { chatCommand } from "./commands/Chat";
import { eventCommand } from "./commands/Event";
import { startCommand } from "./commands/Start";
import { stopCommand } from "./commands/Stop";

/**
 * Single host CLI entry. Citty parses argv, dispatches to one of the
 * four subcommands, and renders `--help` / per-command help. Each
 * subcommand handles its own bootstrap and env requirements.
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
            chat: chatCommand,
            event: eventCommand,
        },
    }),
);
