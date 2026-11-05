import { type ParsedChatInput, parseChatInput } from "@getfamiliar/shared";

/**
 * Builtin commands accepted by the cli-chat REPL. Anything else
 * starting with `/` is interpreted as a direct handler call.
 */
export const CLI_CHAT_BUILTINS = ["/exit", "/clear"] as const;
export type CliChatBuiltin = (typeof CLI_CHAT_BUILTINS)[number];

/** One parsed REPL line (see {@link parseChatInput}). */
export type ParsedInput = ParsedChatInput<CliChatBuiltin>;

/**
 * Parse one raw REPL line with the cli-chat builtins (`/exit`, `/clear`).
 *
 * @param raw The typed line.
 * @returns The parsed input.
 */
export function parseInput(raw: string): ParsedInput {
    return parseChatInput(raw, CLI_CHAT_BUILTINS);
}
