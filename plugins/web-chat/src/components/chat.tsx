import { ChevronUpIcon, WifiOffIcon, XIcon } from "lucide-react";
import * as React from "react";
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
import type { ChatMessageDto } from "@/host/ChatProtocol";
import { formatTime } from "@/lib/time";
import { buildTranscript } from "@/lib/transcript";

/**
 * The web chat page (layout of the shadcn chatbot template): the
 * transcript in a message scroller, the input below; an empty state
 * before the first message. `/clear` hides the transcript in this view
 * (the assistant keeps its history, as in cli-chat).
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

    const onSubmit = async (text: string): Promise<boolean> => {
        if (text === "/clear") {
            chat.clear();
            return true;
        }
        return chat.send(text);
    };

    return (
        <div className="flex min-h-0 w-full flex-1 flex-col">
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
                                            <ChatMessage message={item.message} />
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
                <PromptForm commands={commands} history={chat.inputHistory} onSubmit={onSubmit} />
            </div>
        </div>
    );
}

/**
 * One stored message: the user's as a bubble, the assistant's as markdown
 * with copy action and time.
 *
 * @param props.message The message.
 * @returns The message.
 */
function ChatMessage({ message }: { readonly message: ChatMessageDto }) {
    if (message.role === "user") {
        return (
            <Message align="end">
                <MessageContent>
                    <Bubble align="end" variant="muted">
                        <BubbleContent className="whitespace-pre-wrap">
                            {message.text}
                        </BubbleContent>
                    </Bubble>
                    <MessageFooter className="px-0">{formatTime(message.createdAt)}</MessageFooter>
                </MessageContent>
            </Message>
        );
    }
    return (
        <Message align="start">
            <MessageContent>
                <Markdown text={message.text} />
                <MessageActions text={message.text} createdAt={message.createdAt} />
            </MessageContent>
        </Message>
    );
}
