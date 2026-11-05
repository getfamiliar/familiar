/**
 * Parsing of one line a user typed into a chat (cli-chat, web-chat):
 * a builtin command of the chat client, a direct handler call
 * (`/topic/sub …`) or a plain message.
 */

/**
 * Result of {@link parseChatInput}.
 *
 * A `handler` arm covers both the plain message (no topic — the chat
 * plugin's own topic applies) and the `/topic/sub/handler …` direct call,
 * whose path is the handler's topic.
 */
export type ParsedChatInput<Builtin extends string = string> =
    | {
          readonly kind: "handler";
          readonly topic?: string;
          readonly prompt: string;
          /**
           * Trimmed raw input line, before slash-command parsing. For direct
           * calls this is what the chat persists as the `role='user'`
           * chatmessage (`NewEvent.userChatMessage`), so later chat turns see
           * exactly what the user typed. For plain messages it equals `prompt`.
           */
          readonly rawInput: string;
      }
    | { readonly kind: "builtin"; readonly command: Builtin };

/**
 * Parse one raw input line.
 *
 * Rules:
 * - A line whose first word is one of `builtins` → builtin.
 * - `/a/b … rest` (any other `/` path) → handler call with topic `a:b`;
 *   anything after the first space is the prompt.
 * - Anything else (and a bare `/`) → plain message, the trimmed line is
 *   the prompt.
 *
 * @param raw The typed line.
 * @param builtins The chat client's own commands (e.g. `["/exit", "/clear"]`).
 * @returns The parsed input.
 */
export function parseChatInput<Builtin extends string>(
    raw: string,
    builtins: readonly Builtin[],
): ParsedChatInput<Builtin> {
    const line = raw.trim();
    if (!line.startsWith("/")) {
        return { kind: "handler", prompt: line, rawInput: line };
    }
    const spaceIdx = line.indexOf(" ");
    const commandPart = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const messagePart = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();

    if ((builtins as readonly string[]).includes(commandPart)) {
        return { kind: "builtin", command: commandPart as Builtin };
    }
    // Empty segments (trailing `/` or `//`) produce no topic words.
    const segments = commandPart
        .slice(1)
        .split("/")
        .filter((segment) => segment.length > 0);
    if (segments.length === 0) {
        return { kind: "handler", prompt: line, rawInput: line };
    }
    return {
        kind: "handler",
        topic: segments.join(":"),
        prompt: messagePart,
        rawInput: line,
    };
}
