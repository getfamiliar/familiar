import { CheckIcon, CopyIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { MessageFooter } from "@/components/ui/message";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatTime } from "@/lib/time";

/**
 * Actions under an assistant message: copy its markdown (from the
 * chatbot template; retry is left out — a turn cannot be regenerated).
 *
 * @param props.text Message text.
 * @param props.createdAt ISO time of the message, shown next to the actions.
 * @returns The footer.
 */
export function MessageActions({
    text,
    createdAt,
}: {
    readonly text: string;
    readonly createdAt: string;
}) {
    const [isCopied, setIsCopied] = React.useState(false);
    React.useEffect(() => {
        if (!isCopied) {
            return;
        }
        const timeout = setTimeout(() => setIsCopied(false), 2000);
        return () => clearTimeout(timeout);
    }, [isCopied]);
    const label = isCopied ? "Copied" : "Copy";
    return (
        <MessageFooter className="px-0">
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={label}
                        onClick={() => {
                            navigator.clipboard
                                .writeText(text)
                                .then(() => setIsCopied(true))
                                .catch(() => {});
                        }}
                    >
                        {isCopied ? <CheckIcon /> : <CopyIcon />}
                    </Button>
                </TooltipTrigger>
                <TooltipContent>
                    <p>{label}</p>
                </TooltipContent>
            </Tooltip>
            <span className="text-xs text-muted-foreground">{formatTime(createdAt)}</span>
        </MessageFooter>
    );
}
