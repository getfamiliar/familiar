import { type CommandDef, defineCommand } from "citty";
import type { HostContext } from "@getfamiliar/shared";
import { providers } from "./providers/Registry.js";

/**
 * Build the citty subcommands exposed under `./cli.sh mail`. Each
 * registered provider contributes a nested subcommand
 * (`./cli.sh mail <provider-id> <action>`).
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
export function buildCommands(ctx: HostContext): readonly CommandDef<any>[] {
    return providers.map((provider) => provider.buildCommands(ctx));
}

/**
 * Top-level mail-plugin help text. Exported because the plugin's
 * `host.main` wires it as the default behavior of `./cli.sh mail`.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
export function buildMain(): CommandDef<any> {
    return defineCommand({
        meta: {
            name: "mail",
            description:
                "Mail plugin. Use `./cli.sh mail <provider> --help` to see provider-specific subcommands.",
        },
        run() {
            const ids = providers.map((p) => `  ${p.id}  — ${p.displayName}`).join("\n");
            process.stdout.write(
                `Mail providers registered:\n${ids}\n\n` +
                    `Use ./cli.sh mail <provider> status / login to interact.\n`,
            );
        },
    });
}
