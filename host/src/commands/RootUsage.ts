import { writeMarkdown } from "@getfamiliar/shared";
import { type CommandDef, type SubCommandsDef, showUsage } from "citty";

/** One section of the root `--help` output. */
export interface CommandGroup {
    readonly title: string;
    /** Root subcommand names listed in this group, in display order. */
    readonly commands: readonly string[];
}

/**
 * Build a citty `showUsage` replacement that renders the root command's
 * help with its subcommands split into titled groups. Subcommands not
 * named in any group (the plugin-provided commands) are appended to the
 * `catchAllTitle` group. Help for every other command is delegated to
 * citty's default renderer.
 *
 * @param root - the root command whose help is grouped
 * @param groups - the groups in display order
 * @param catchAllTitle - title of the group that collects unlisted commands
 * @returns a function suitable for `runMain`'s `showUsage` option
 */
export function createGroupedShowUsage(
    root: CommandDef,
    groups: readonly CommandGroup[],
    catchAllTitle: string,
): typeof showUsage {
    return async (cmd, parent) => {
        if (cmd !== root || parent !== undefined) {
            await showUsage(cmd, parent);
            return;
        }
        writeMarkdown(await renderGroupedUsage(root, groups, catchAllTitle));
    };
}

/**
 * Render the root help as markdown: description, usage line and one
 * bullet list per group.
 *
 * @param root - the root command
 * @param groups - the groups in display order
 * @param catchAllTitle - title of the group that collects unlisted commands
 * @returns markdown source for {@link writeMarkdown}
 */
async function renderGroupedUsage(
    root: CommandDef,
    groups: readonly CommandGroup[],
    catchAllTitle: string,
): Promise<string> {
    const meta = await resolveValue(root.meta);
    const subCommands = (await resolveValue(root.subCommands)) ?? {};
    const descriptions = await describeSubCommands(subCommands);
    const listed = new Set(groups.flatMap((group) => group.commands));
    const unlisted = Object.keys(subCommands).filter((name) => !listed.has(name));
    const resolvedGroups = groups.map((group) =>
        group.title === catchAllTitle
            ? { ...group, commands: [...group.commands, ...unlisted] }
            : group,
    );

    const name = meta?.name ?? "familiar";
    const sections = resolvedGroups
        .filter((group) => group.commands.some((command) => descriptions.has(command)))
        .map((group) => {
            const lines = group.commands
                .filter((command) => descriptions.has(command))
                .map((command) => `- \`${command}\` — ${descriptions.get(command)}`);
            return `## ${group.title}\n\n${lines.join("\n")}\n`;
        });
    return (
        `${meta?.description ?? ""}\n\n` +
        `**Usage:** \`${name} <command> [OPTIONS]\`\n\n` +
        `${sections.join("\n")}\n` +
        `Use \`${name} <command> --help\` for more information about a command.\n`
    );
}

/**
 * Map each subcommand name to its one-line description.
 *
 * @param subCommands - the root's subcommand map
 * @returns name → description (empty string when a command has none)
 */
async function describeSubCommands(subCommands: SubCommandsDef): Promise<Map<string, string>> {
    const descriptions = new Map<string, string>();
    for (const [name, sub] of Object.entries(subCommands)) {
        const command = await resolveValue(sub);
        const meta = await resolveValue(command?.meta);
        descriptions.set(name, meta?.description ?? "");
    }
    return descriptions;
}

/**
 * Resolve one of citty's `Resolvable` values (plain, promise, or
 * factory returning either).
 *
 * @param value - the resolvable
 * @returns the resolved value
 */
async function resolveValue<T>(value: T | Promise<T> | (() => T | Promise<T>)): Promise<T> {
    return typeof value === "function" ? await (value as () => T | Promise<T>)() : await value;
}
