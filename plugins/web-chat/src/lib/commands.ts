/** Most suggestions shown at once. */
const MAX_SUGGESTIONS = 8;

/**
 * Slash commands matching the input: only while it starts with `/` and
 * has no whitespace yet (the command word is being typed).
 *
 * @param input Current input.
 * @param commands Builtins and handler paths.
 * @returns Matching commands, at most {@link MAX_SUGGESTIONS}.
 */
export function suggestCommands(input: string, commands: readonly string[]): string[] {
    if (!input.startsWith("/") || /\s/.test(input)) {
        return [];
    }
    return commands
        .filter((command) => command.startsWith(input) && command !== input)
        .slice(0, MAX_SUGGESTIONS);
}
