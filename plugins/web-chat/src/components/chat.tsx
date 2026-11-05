import { ChevronUpIcon, FileUpIcon, WifiOffIcon, XIcon } from "lucide-react";
import * as React from "react";
import { StoredFiles } from "@/components/file-chip";
import { Markdown } from "@/components/markdown";
import { MessageActions } from "@/components/message-actions";
import { PromptForm } from "@/components/prompt-form";
import { TurnTrace } from "@/components/turn-trace";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import {
    MessageScroller,
    MessageScrollerButton,
    MessageScrollerContent,
    MessageScrollerItem,
    MessageScrollerProvider,
    MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { useChat } from "@/hooks/use-chat";
import {
    type ChatFileDto,
    type ChatMessageDto,
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_FILES,
} from "@/host/ChatProtocol";
import { formatBytes, isFileDrag, stripAttachmentNote } from "@/lib/files";
import { formatTime } from "@/lib/time";
import { buildTranscript } from "@/lib/transcript";

/**
 * The web chat page (layout of the shadcn chatbot template): the
 * transcript in a message scroller, the input below; an empty state
 * before the first message. `/clear` hides the transcript in this view
 * (the assistant keeps its history, as in cli-chat).
 *
 * Files dropped anywhere on the chat are attached to the next message;
 * a message's attachments show at the user's message, files the
 * assistant produced in the event's scratch folder under its reply.
 *
 * @param props.apiBase Base URL of the chat API.
 * @returns The chat.
 */
export function Chat({ apiBase }: { readonly apiBase: string }) {
    const chat = useChat(apiBase);
    const commands = React.useMemo(
        () => [...chat.commands.builtins, ...chat.commands.handlers],
        [chat.commands],
    );
    const transcript = buildTranscript(chat.messages, chat.turns);
    const [attachments, setAttachments] = React.useState<readonly File[]>([]);
    const [attachmentError, setAttachmentError] = React.useState<string | null>(null);
    const [isDragging, setIsDragging] = React.useState(false);
    /** Nested dragenter / dragleave pairs of child elements. */
    const dragDepth = React.useRef(0);

    /** The last assistant message of each event: produced files show under it. */
    const lastReplyOfEvent = React.useMemo(() => {
        const last = new Map<string, string>();
        for (const message of chat.messages) {
            if (message.role === "assistant") {
                last.set(message.eventId, message.id);
            }
        }
        return last;
    }, [chat.messages]);

    const addFiles = (added: readonly File[]) => {
        if (added.length === 0) {
            return;
        }
        const next = [...attachments, ...added];
        const total = next.reduce((sum, file) => sum + file.size, 0);
        if (next.length > MAX_UPLOAD_FILES) {
            setAttachmentError(`At most ${MAX_UPLOAD_FILES} files per message.`);
            return;
        }
        if (total > MAX_UPLOAD_BYTES) {
            setAttachmentError(
                `That would be ${formatBytes(total)}; at most ${formatBytes(MAX_UPLOAD_BYTES)} per message.`,
            );
            return;
        }
        setAttachmentError(null);
        setAttachments(next);
    };

    const onSubmit = async (text: string): Promise<boolean> => {
        if (text === "/clear") {
            chat.clear();
            return true;
        }
        const isSent = await chat.send(text, attachments);
        if (isSent) {
            setAttachments([]);
            setAttachmentError(null);
        }
        return isSent;
    };

    return (
        <section
            aria-label="Chat"
            className="relative flex min-h-0 w-full flex-1 flex-col"
            onDragEnter={(event) => {
                if (!isFileDrag(event)) {
                    return;
                }
                event.preventDefault();
                dragDepth.current += 1;
                setIsDragging(true);
            }}
            onDragOver={(event) => {
                if (isFileDrag(event)) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                }
            }}
            onDragLeave={(event) => {
                if (!isFileDrag(event)) {
                    return;
                }
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (dragDepth.current === 0) {
                    setIsDragging(false);
                }
            }}
            onDrop={(event) => {
                if (!isFileDrag(event)) {
                    return;
                }
                event.preventDefault();
                dragDepth.current = 0;
                setIsDragging(false);
                addFiles([...event.dataTransfer.files]);
            }}
        >
            {isDragging && (
                <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary/40 bg-background/80 backdrop-blur-sm">
                    <FileUpIcon className="size-8 text-muted-foreground" />
                    <p className="text-sm font-medium">
                        Drop files to attach them to your next message
                    </p>
                    <p className="text-xs text-muted-foreground">
                        Up to {MAX_UPLOAD_FILES} files, {formatBytes(MAX_UPLOAD_BYTES)} in total
                    </p>
                </div>
            )}
            {transcript.length === 0 ? (
                <div className="flex flex-1 items-center justify-center p-6">
                    <Empty>
                        <EmptyHeader>
                            <EmptyTitle>What can I help with?</EmptyTitle>
                            <EmptyDescription>
                                {chat.isLoaded
                                    ? "Your messages go to familiar. Type / to call a handler directly."
                                    : "Loading the conversation…"}
                            </EmptyDescription>
                        </EmptyHeader>
                        {chat.hasMore && (
                            <EmptyContent>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void chat.loadOlder()}
                                >
                                    Show earlier messages
                                </Button>
                            </EmptyContent>
                        )}
                    </Empty>
                </div>
            ) : (
                <MessageScrollerProvider>
                    <MessageScroller className="min-h-0 flex-1">
                        <MessageScrollerViewport>
                            <MessageScrollerContent className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6">
                                {chat.hasMore && (
                                    <div className="flex justify-center">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => void chat.loadOlder()}
                                        >
                                            <ChevronUpIcon />
                                            Earlier messages
                                        </Button>
                                    </div>
                                )}
                                {transcript.map((item) =>
                                    item.kind === "message" ? (
                                        <MessageScrollerItem
                                            key={`m${item.message.id}`}
                                            messageId={`m${item.message.id}`}
                                            scrollAnchor={item.message.role === "user"}
                                        >
                                            <ChatMessage
                                                message={item.message}
                                                files={filesToShow(
                                                    item.message,
                                                    chat.files.get(item.message.eventId) ?? [],
                                                    lastReplyOfEvent,
                                                )}
                                            />
                                        </MessageScrollerItem>
                                    ) : (
                                        <MessageScrollerItem
                                            key={`t${item.turn.eventId}`}
                                            messageId={`t${item.turn.eventId}`}
                                        >
                                            <Message>
                                                <MessageContent>
                                                    <TurnTrace turn={item.turn} />
                                                </MessageContent>
                                            </Message>
                                        </MessageScrollerItem>
                                    ),
                                )}
                            </MessageScrollerContent>
                        </MessageScrollerViewport>
                        <MessageScrollerButton />
                    </MessageScroller>
                </MessageScrollerProvider>
            )}
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 pb-6">
                {!chat.isConnected && chat.isLoaded && (
                    <Alert>
                        <WifiOffIcon />
                        <AlertTitle>Reconnecting…</AlertTitle>
                        <AlertDescription>
                            Live updates are interrupted; new replies show up once the connection is
                            back.
                        </AlertDescription>
                    </Alert>
                )}
                {attachmentError !== null && (
                    <Alert variant="destructive">
                        <AlertTitle>Cannot attach</AlertTitle>
                        <AlertDescription>{attachmentError}</AlertDescription>
                        <AlertAction>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Dismiss"
                                onClick={() => setAttachmentError(null)}
                            >
                                <XIcon />
                            </Button>
                        </AlertAction>
                    </Alert>
                )}
                {chat.error !== null && (
                    <Alert variant="destructive">
                        <AlertTitle>Could not send</AlertTitle>
                        <AlertDescription>{chat.error}</AlertDescription>
                        <AlertAction>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Dismiss"
                                onClick={chat.dismissError}
                            >
                                <XIcon />
                            </Button>
                        </AlertAction>
                    </Alert>
                )}
                <PromptForm
                    commands={commands}
                    history={chat.inputHistory}
                    attachments={attachments}
                    onAddFiles={addFiles}
                    onRemoveAttachment={(index) =>
                        setAttachments((current) =>
                            current.filter((_, position) => position !== index),
                        )
                    }
                    onSubmit={onSubmit}
                />
            </div>
        </section>
    );
}

/**
 * The files to show with a message: its attachments at the user's
 * message, the files the assistant produced under the event's last reply.
 *
 * @param message The message.
 * @param eventFiles Files of its event.
 * @param lastReplyOfEvent Last assistant message id per event.
 * @returns The files for this message.
 */
function filesToShow(
    message: ChatMessageDto,
    eventFiles: readonly ChatFileDto[],
    lastReplyOfEvent: ReadonlyMap<string, string>,
): readonly ChatFileDto[] {
    if (message.role === "user") {
        return eventFiles.filter((file) => file.isUpload);
    }
    return lastReplyOfEvent.get(message.eventId) === message.id
        ? eventFiles.filter((file) => !file.isUpload)
        : [];
}

/**
 * One stored message: the user's as a bubble with its attachments, the
 * assistant's as markdown with the produced files, copy action and time.
 *
 * @param props.message The message.
 * @param props.files Files to show with it.
 * @returns The message.
 */
function ChatMessage({
    message,
    files,
}: {
    readonly message: ChatMessageDto;
    readonly files: readonly ChatFileDto[];
}) {
    if (message.role === "user") {
        const text = files.length > 0 ? stripAttachmentNote(message.text) : message.text;
        return (
            <Message align="end">
                <MessageContent>
                    <StoredFiles files={files} align="end" />
                    {text.trim() !== "" && (
                        <Bubble align="end" variant="muted">
                            <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
                        </Bubble>
                    )}
                    <MessageFooter className="px-0">{formatTime(message.createdAt)}</MessageFooter>
                </MessageContent>
            </Message>
        );
    }
    return (
        <Message align="start">
            <MessageContent>
                <Markdown text={message.text} />
                <StoredFiles files={files} align="start" />
                <MessageActions text={message.text} createdAt={message.createdAt} />
            </MessageContent>
        </Message>
    );
}
