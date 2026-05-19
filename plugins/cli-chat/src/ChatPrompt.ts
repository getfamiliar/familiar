import {
    createPrompt,
    isEnterKey,
    type KeypressEvent,
    makeTheme,
    type Status,
    type Theme,
    useKeypress,
    useState,
} from "@inquirer/core";
import chalk from "chalk";

const PROMPT = "> ";
const MAX_SUGGESTIONS = 6;

/**
 * Config accepted by {@link chatPrompt}. The two arrays drive
 * tab-completion / arrow-navigation when the user is typing a `/`
 * command; `history` powers the up/down-arrow recall of previously
 * submitted lines. All default to empty so the component is usable
 * without any of them.
 */
export interface ChatPromptConfig {
    /** Builtin commands shown as completion candidates (e.g. `/exit`). */
    readonly builtins?: readonly string[];
    /** Handler slash-paths to complete (e.g. `/chat/telegram/index`). */
    readonly handlerPaths?: readonly string[];
    /**
     * Past inputs the user has submitted in this session, oldest
     * first. The prompt recalls them with ↑ / ↓ when the suggestion
     * list isn't active.
     */
    readonly history?: readonly string[];
    /** Optional theme override; defaults to inquirer's built-in. */
    readonly theme?: Partial<Theme>;
}

/**
 * Filter the catalog down to entries that start with the current
 * buffer. Completion is only useful while the user is still typing
 * the command part — once a space is in the buffer, the rest is the
 * prompt and completion would just clutter the screen.
 */
function getSuggestions(
    buffer: string,
    builtins: readonly string[],
    handlerPaths: readonly string[],
): readonly string[] {
    if (!buffer.startsWith("/") || buffer.includes(" ")) {
        return [];
    }
    const candidates = [...builtins, ...handlerPaths];
    return candidates.filter((c) => c.startsWith(buffer)).slice(0, MAX_SUGGESTIONS);
}

/**
 * Custom inquirer prompt for the cli-chat REPL. Behaves like a
 * single-line text input with three extras:
 *
 * - Tab completion: while the buffer starts with `/` (and contains no
 *   space yet), up to {@link MAX_SUGGESTIONS} suggestions are rendered
 *   below the prompt. Up/Down navigates, Tab inserts the highlighted
 *   suggestion and appends a space so the user can keep typing the
 *   message.
 * - History recall: when no suggestion list is showing, Up walks back
 *   through {@link ChatPromptConfig.history} (most-recent first) and
 *   Down walks forward, with index 0 restoring the empty buffer.
 * - Enter submits the raw buffer. Parsing into builtin/handler is
 *   handled outside (see {@link parseInput}).
 */
export const chatPrompt = createPrompt<string, ChatPromptConfig>((config, done) => {
    const [value, setValue] = useState("");
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [historyCursor, setHistoryCursor] = useState(0);
    const [status, setStatus] = useState<Status>("idle");
    const theme = makeTheme(config.theme);
    const builtins = config.builtins ?? [];
    const handlerPaths = config.handlerPaths ?? [];
    const history = config.history ?? [];

    const suggestions = getSuggestions(value, builtins, handlerPaths);
    const showSuggestions = suggestions.length > 0 && status === "idle";

    useKeypress((key: KeypressEvent, rl) => {
        if (status !== "idle") {
            return;
        }
        if (isEnterKey(key)) {
            setStatus("done");
            done(value);
            return;
        }
        if (key.name === "tab" && showSuggestions) {
            const completion = `${suggestions[selectedIdx]} `;
            setValue(completion);
            rl.line = completion;
            // No public cursor setter on InquirerReadline; the next
            // keypress places the cursor at end of buffer regardless.
            setSelectedIdx(0);
            setHistoryCursor(0);
            return;
        }
        if (showSuggestions && (key.name === "up" || key.name === "down")) {
            const delta = key.name === "up" ? -1 : 1;
            const next = (selectedIdx + delta + suggestions.length) % suggestions.length;
            setSelectedIdx(next);
            // Keep the readline buffer pinned to our state so the
            // up/down keypress doesn't get treated as history nav.
            rl.line = value;
            return;
        }
        if (!showSuggestions && (key.name === "up" || key.name === "down")) {
            if (history.length === 0) {
                return;
            }
            const delta = key.name === "up" ? 1 : -1;
            const next = Math.max(0, Math.min(history.length, historyCursor + delta));
            if (next === historyCursor) {
                return;
            }
            // cursor 0 = empty buffer (present), 1 = most-recent entry,
            // history.length = oldest entry.
            const recalled = next === 0 ? "" : (history[history.length - next] ?? "");
            setHistoryCursor(next);
            setValue(recalled);
            rl.line = recalled;
            return;
        }
        setValue(rl.line);
        setSelectedIdx(0);
        // Any non-arrow key edits the buffer, so reset to the
        // "present" history cursor — otherwise the next ↑ would jump
        // back to wherever the cursor was left, surprising the user.
        if (historyCursor !== 0) {
            setHistoryCursor(0);
        }
    });

    const chevron = chalk.cyan(PROMPT);
    const rendered = status === "done" ? chalk.cyan(value) : value;
    const promptLine = `${chevron}${rendered}`;

    if (!showSuggestions) {
        return promptLine;
    }
    const list = suggestions
        .map((s, i) => (i === selectedIdx ? theme.style.highlight(`❯ ${s}`) : `  ${chalk.dim(s)}`))
        .join("\n");
    return [promptLine, list];
});
