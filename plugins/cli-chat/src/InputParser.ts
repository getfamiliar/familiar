/**
 * Builtin commands accepted by the cli-chat REPL. Anything else
 * starting with `/` is interpreted as a direct handler call.
 */
export const CLI_CHAT_BUILTINS = ["/exit", "/clear"] as const;
export type CliChatBuiltin = (typeof CLI_CHAT_BUILTINS)[number];

/**
 * Result of parsing one user-entered line.
 *
 * A `handler` arm covers both the plain-prompt case (no topic / no
 * startHandler — the platform falls back to `chat:cli` + `index`) and
 * the `/topic/sub/handler …` direct-call case. There is no separate
 * "prompt" kind because a plain prompt is just a default handler call
 * — keeping a single arm avoids divergent emit code paths.
 */
export type ParsedInput =
    | {
          readonly kind: "handler";
          readonly topic?: string;
          readonly startHandler?: string;
          readonly prompt: string;
      }
    | { readonly kind: "builtin"; readonly command: CliChatBuiltin };

/**
 * Parse one raw input line into a {@link ParsedInput}.
 *
 * Rules:
 * - `/exit` / `/clear` → builtin.
 * - `/a/b … rest` (≥ 2 path segments after the leading `/`) → handler
 *   call with topic = `a:b…`-without-last and startHandler = the last
 *   segment. Anything after the first space is the prompt.
 * - Anything else (including a single-segment `/foo` that isn't a
 *   builtin) → plain handler with no topic/startHandler. The literal
 *   line goes through as the prompt so the model sees it.
 */
export function parseInput(raw: string): ParsedInput {
    const line = raw.trim();
    if (!line.startsWith("/")) {
        return { kind: "handler", prompt: line };
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
    if (segments.length >= 2) {
        const startHandler = segments[segments.length - 1];
        const topic = segments.slice(0, -1).join(":");
        return { kind: "handler", topic, startHandler, prompt: messagePart };
    }

    // Single-segment `/foo` that isn't a recognised builtin — let the
    // literal line through as a plain prompt rather than erroring, so
    // typos don't block the user.
    return { kind: "handler", prompt: line };
}
