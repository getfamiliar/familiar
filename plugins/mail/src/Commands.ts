import { type CommandDef, defineCommand } from "citty";
import type { HostContext, McpInfo } from "effective-assistant-shared";
import { providers } from "./providers/Registry.js";

/**
 * Build the citty subcommands exposed under `./cli.sh mail`. Each
 * registered {@link MailProvider} contributes a nested subcommand
 * (`./cli.sh mail <provider-id> <action>`). The mapping from
 * provider package to `mcp.yml` key is resolved once per command
 * tree build so subcommands can render actionable hints when the
 * MCP isn't installed (instead of crashing).
 */
// biome-ignore lint/suspicious/noExplicitAny: matches citty's SubCommandsDef pattern.
export function buildCommands(ctx: HostContext): readonly CommandDef<any>[] {
    const installed = ctx.mcp.getList();
    const cmds = providers.map((provider) => {
        const mcpKey = findMcpKey(installed, provider.packageName);
        return provider.buildCommands(ctx, mcpKey);
    });
    // Wrap each provider command tree into one root subcommand named
    // after the provider id so they appear under `./cli.sh mail`.
    // The provider's `buildCommands` already sets `meta.name`, so
    // citty mounts them directly.
    return cmds;
}

/** Same lookup as MailDaemon.findMcpKey, duplicated to keep modules acyclic. */
function findMcpKey(installed: readonly McpInfo[], packageName: string): string | null {
    for (const info of installed) {
        if (info.package === packageName) {
            return info.key;
        }
    }
    return null;
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
                    `Use ./cli.sh mail <provider> status / list-mailboxes to interact.\n`,
            );
        },
    });
}
