import { ArrowUpIcon, SlashIcon } from "lucide-react";
import * as React from "react";
import {
    InputGroup,
    InputGroupAddon,
    InputGroupButton,
    InputGroupTextarea,
} from "@/components/ui/input-group";
import { suggestCommands } from "@/lib/commands";

/**
 * The message input (from the chatbot template's prompt form): Enter
 * sends, Shift+Enter breaks the line. Typing `/` suggests builtins and
 * handler paths (↑/↓ to pick, Tab or Enter to complete, Esc to close),
 * like cli-chat's tab completion; ↑ / ↓ on a single-line input walk
 * through your earlier messages.
 *
 * @param props.commands Builtins and handler slash paths.
 * @param props.history Your earlier messages, oldest first.
 * @param props.onSubmit Called with the trimmed text; resolves false to keep the input.
 * @returns The form.
 */
export function PromptForm({
    commands,
    history,
    onSubmit,
}: {
    readonly commands: readonly string[];
    readonly history: readonly string[];
    readonly onSubmit: (text: string) => Promise<boolean>;
}) {
    const [input, setInput] = React.useState("");
    const [selected, setSelected] = React.useState(0);
    const [isDismissed, setIsDismissed] = React.useState(false);
    const [isSending, setIsSending] = React.useState(false);
    /** Position in `history` while browsing it, null otherwise. */
    const [historyIndex, setHistoryIndex] = React.useState<number | null>(null);
    const draft = React.useRef("");
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);

    const suggestions = isDismissed ? [] : suggestCommands(input, commands);
    const activeSuggestion = suggestions[Math.min(selected, suggestions.length - 1)];

    const updateInput = (value: string) => {
        setInput(value);
        setSelected(0);
        setIsDismissed(false);
        setHistoryIndex(null);
    };

    const submit = async () => {
        const text = input.trim();
        if (text === "" || isSending) {
            return;
        }
        setIsSending(true);
        try {
            if (await onSubmit(text)) {
                updateInput("");
            }
        } finally {
            setIsSending(false);
            textareaRef.current?.focus();
        }
    };

    /**
     * Walk through the earlier messages.
     *
     * @param direction -1 for older, +1 for newer.
     */
    const browseHistory = (direction: -1 | 1) => {
        if (history.length === 0) {
            return;
        }
        if (historyIndex === null) {
            if (direction === 1) {
                return;
            }
            draft.current = input;
            setHistoryIndex(history.length - 1);
            setInput(history[history.length - 1] ?? "");
            return;
        }
        const next = historyIndex + direction;
        if (next >= history.length) {
            setHistoryIndex(null);
            setInput(draft.current);
            return;
        }
        const clamped = Math.max(0, next);
        setHistoryIndex(clamped);
        setInput(history[clamped] ?? "");
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.nativeEvent.isComposing) {
            return;
        }
        if (suggestions.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setSelected((index) => (index + delta + suggestions.length) % suggestions.length);
                return;
            }
            if ((event.key === "Tab" || event.key === "Enter") && activeSuggestion !== undefined) {
                event.preventDefault();
                updateInput(`${activeSuggestion} `);
                return;
            }
            if (event.key === "Escape") {
                event.preventDefault();
                setIsDismissed(true);
                return;
            }
        }
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
            return;
        }
        if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !input.includes("\n")) {
            event.preventDefault();
            browseHistory(event.key === "ArrowUp" ? -1 : 1);
        }
    };

    return (
        <form
            className="relative"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            {suggestions.length > 0 && (
                <div
                    role="listbox"
                    aria-label="Commands"
                    className="absolute bottom-full left-0 z-10 mb-2 w-full max-w-sm overflow-hidden rounded-xl border bg-popover p-1 text-sm text-popover-foreground shadow-md"
                >
                    {suggestions.map((suggestion) => (
                        <button
                            key={suggestion}
                            type="button"
                            role="option"
                            aria-selected={suggestion === activeSuggestion}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left font-mono text-xs aria-selected:bg-accent aria-selected:text-accent-foreground"
                            onMouseDown={(event) => {
                                event.preventDefault();
                                updateInput(`${suggestion} `);
                                textareaRef.current?.focus();
                            }}
                        >
                            <SlashIcon className="size-3 text-muted-foreground" />
                            {suggestion.slice(1)}
                        </button>
                    ))}
                </div>
            )}
            <InputGroup>
                <InputGroupTextarea
                    ref={textareaRef}
                    autoFocus
                    placeholder="Send a message… (type / for handlers)"
                    className="max-h-48 p-3.5"
                    value={input}
                    onChange={(event) => updateInput(event.target.value)}
                    onKeyDown={onKeyDown}
                />
                <InputGroupAddon align="block-end">
                    <span className="text-xs text-muted-foreground">
                        Enter to send · Shift+Enter for a new line
                    </span>
                    <InputGroupButton
                        type="submit"
                        size="icon-sm"
                        variant="default"
                        aria-label="Send message"
                        className="ml-auto"
                        disabled={input.trim() === "" || isSending}
                    >
                        <ArrowUpIcon />
                    </InputGroupButton>
                </InputGroupAddon>
            </InputGroup>
        </form>
    );
}
