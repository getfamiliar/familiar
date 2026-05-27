import {
    createPrompt,
    isEnterKey,
    type KeypressEvent,
    makeTheme,
    type Status,
    type Theme,
    useEffect,
    useKeypress,
    useRef,
    useState,
} from "@inquirer/core";
import chalk from "chalk";

const PROMPT = "> ";
const MAX_SUGGESTIONS = 6;

/**
 * How a {@link chatPrompt} resolved.
 *
 * - `submit` — the user pressed Enter; `value` is the typed line.
 * - `interrupted` — the REPL fired {@link ChatPromptConfig.interruptSignal}
 *   to make room for a proactive assistant message. `value` is whatever
 *   was typed so far, so the caller can re-seed the redrawn prompt with
 *   it via {@link ChatPromptConfig.initialValue} (no lost keystrokes).
 *
 * Genuine exits (session abort / Ctrl-C) don't produce a result — they
 * reject the prompt with `AbortPromptError` / `ExitPromptError` instead.
 */
export interface ChatPromptResult {
    readonly value: string;
    readonly reason: "submit" | "interrupted";
}

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
    /**
     * When fired, the prompt resolves immediately with
     * `reason: "interrupted"` and the current buffer instead of waiting
     * for Enter. The REPL uses this to free the terminal line for a
     * proactive assistant message, then redraws a fresh prompt seeded
     * with the preserved buffer.
     */
    readonly interruptSignal?: AbortSignal;
    /** Initial buffer contents; defaults to empty. */
    readonly initialValue?: string;
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
 * - {@link ChatPromptConfig.interruptSignal} resolves the prompt early
 *   with the current buffer (`reason: "interrupted"`) so the REPL can
 *   surface a proactive assistant message and redraw without losing
 *   what was typed.
 */
export const chatPrompt = createPrompt<ChatPromptResult, ChatPromptConfig>((config, done) => {
    const [value, setValue] = useState(config.initialValue ?? "");
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [historyCursor, setHistoryCursor] = useState(0);
    const [status, setStatus] = useState<Status>("idle");
    const theme = makeTheme(config.theme);
    const builtins = config.builtins ?? [];
    const handlerPaths = config.handlerPaths ?? [];
    const history = config.history ?? [];

    // Seed the readline's editable buffer with the initial value on
    // mount. `useState` above only seeds the *displayed* value; the
    // underlying `rl.line` stays empty, so the first keypress would
    // run `setValue(rl.line)` and wipe the preserved text. Writing it
    // into `rl` keeps both in sync and places the cursor at the end.
    useEffect((rl) => {
        const seed = config.initialValue ?? "";
        if (seed.length > 0) {
            rl.write(seed);
        }
    }, []);

    // Mirror the live buffer into a ref so the interrupt listener
    // (registered once below) always reads the latest value rather
    // than the empty string captured at first render.
    const valueRef = useRef(value);
    valueRef.current = value;

    // Set when the prompt is closing because of an interrupt (not a
    // submit). The final render reads it to draw *nothing* so inquirer
    // doesn't leave the usual cyan echo of the prompt line on screen —
    // that echo is wanted for a submit ("> hello") but would be a
    // ghost clone above the redrawn prompt for an interrupt.
    const interruptedRef = useRef(false);

    // Resolve early — with the buffer preserved — when the REPL fires
    // the interrupt signal to make room for a proactive message. This
    // is distinct from inquirer's own `{ signal }` (session abort),
    // which rejects the prompt for a genuine exit.
    useEffect(() => {
        const signal = config.interruptSignal;
        if (signal === undefined) {
            return;
        }
        const onInterrupt = () => {
            interruptedRef.current = true;
            setStatus("done");
            done({ value: valueRef.current, reason: "interrupted" });
        };
        if (signal.aborted) {
            onInterrupt();
            return;
        }
        signal.addEventListener("abort", onInterrupt, { once: true });
        return () => signal.removeEventListener("abort", onInterrupt);
    }, [config.interruptSignal]);

    const suggestions = getSuggestions(value, builtins, handlerPaths);
    const showSuggestions = suggestions.length > 0 && status === "idle";

    useKeypress((key: KeypressEvent, rl) => {
        if (status !== "idle") {
            return;
        }
        if (isEnterKey(key)) {
            setStatus("done");
            done({ value, reason: "submit" });
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

    // Interrupted close: render nothing so the prompt line is cleared
    // outright instead of being finalized as a cyan ghost above the
    // redraw the REPL is about to issue.
    if (status === "done" && interruptedRef.current) {
        return "";
    }

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

/**
 * Callable shape of {@link chatPrompt}, narrowed to what the REPL uses.
 * Declaring it lets {@link runRepl} accept an injected prompt in tests
 * (mirroring {@link RunRenderer}'s `SpinnerFactory` seam) without
 * depending on inquirer's full `Prompt` type.
 */
export type ChatPromptFn = (
    config: ChatPromptConfig,
    context?: { signal?: AbortSignal },
) => Promise<ChatPromptResult>;
