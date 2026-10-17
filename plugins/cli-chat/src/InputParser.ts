/**
 * Builtin commands accepted by the cli-chat REPL. Anything else
 * starting with `/` is interpreted as a direct handler call.
 */
export const CLI_CHAT_BUILTINS = ["/exit", "/clear"] as const;
export type CliChatBuiltin = (typeof CLI_CHAT_BUILTINS)[number];

/**
 * Result of parsing one user-entered line.
 *
 * A `handler` arm covers both the plain-prompt case (no topic — the
 * platform falls back to `chat:cli`) and the `/topic/sub/handler …`
 * direct-call case, whose path is the handler's topic. There is no separate
 * "prompt" kind because a plain prompt is just a default handler call
 * — keeping a single arm avoids divergent emit code paths.
 */
export type ParsedInput =
    | {
          readonly kind: "handler";
          readonly topic?: string;
          readonly prompt: string;
          /**
           * Trimmed raw input line, before slash-command parsing. For
           * direct calls (`/topic/handler …`) this is what cli-chat
           * persists as the `role='user'` chatmessage so subsequent
           * chat-handler turns see exactly what the operator typed.
           * For plain prompts this equals `prompt`.
           */
          readonly rawInput: string;
      }
    | { readonly kind: "builtin"; readonly command: CliChatBuiltin };

/**
 * Parse one raw input line into a {@link ParsedInput}.
 *
 * Rules:
 * - `/exit` / `/clear` → builtin.
 * - `/a/b … rest` (any other `/` path) → handler call with topic
 *   `a:b` — the path is the handler's address (`a/b.md` or
 *   `a/b/index.md`). Anything after the first space is the prompt.
 * - Anything else → plain handler with no topic. The literal line goes
 *   through as the prompt so the model sees it.
 */
export function parseInput(raw: string): ParsedInput {
    const line = raw.trim();
    if (!line.startsWith("/")) {
        return { kind: "handler", prompt: line, rawInput: line };
    }
    const spaceIdx = line.indexOf(" ");
    const commandPart = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const messagePart = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();

    if ((CLI_CHAT_BUILTINS as readonly string[]).includes(commandPart)) {
        return { kind: "builtin", command: commandPart as CliChatBuiltin };
    }

    // commandPart starts with `/`; drop it and split. Empty segments
    // (e.g. trailing `/` or `//`) are filtered out so they don't
    // produce empty topic words.
    const segments = commandPart
        .slice(1)
        .split("/")
        .filter((s) => s.length > 0);
    if (segments.length === 0) {
        // A bare `/` names no handler — let the literal line through as
        // a plain prompt rather than erroring.
        return { kind: "handler", prompt: line, rawInput: line };
    }
    return {
        kind: "handler",
        topic: segments.join(":"),
        prompt: messagePart,
        rawInput: line,
    };
}
