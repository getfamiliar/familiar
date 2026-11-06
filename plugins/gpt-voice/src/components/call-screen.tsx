import {
    AudioLines,
    Loader2,
    Mic,
    MicOff,
    Phone,
    PhoneOff,
    ShieldAlert,
    TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { type CallPhase, useVoiceCall, type VoiceBlocker } from "@/hooks/use-voice-call";
import { cn } from "@/lib/utils";

/** Props of {@link CallScreen}. */
export interface CallScreenProps {
    /** Plugin route prefix (`/plugins/gpt-voice`). */
    readonly basePath: string;
}

/**
 * The call screen, modelled on a video-call app: the assistant's avatar
 * in the middle (it pulses while the assistant speaks; a face will
 * replace it later), status and call duration below, and a control bar
 * with mute and call / hang-up at the bottom.
 *
 * @param props Route prefix.
 * @returns The screen.
 */
export function CallScreen({ basePath }: CallScreenProps) {
    const call = useVoiceCall(basePath);
    const isInCall =
        call.phase === "connecting" || call.phase === "connected" || call.phase === "ending";
    return (
        <div className="flex h-full min-h-[480px] flex-col bg-muted/40">
            <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
                <Avatar isSpeaking={call.isAssistantSpeaking} isInCall={isInCall} />
                <div className="flex flex-col items-center gap-1 text-center">
                    <div className="font-heading text-xl font-medium">Familiar</div>
                    <CallStatus phase={call.phase} connectedAt={call.connectedAt} />
                    {call.runningTaskCount > 0 && (
                        <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-background px-3 py-1 text-muted-foreground text-xs shadow-sm">
                            <Loader2 className="size-3.5 animate-spin" />
                            Working in the background
                            {call.runningTaskCount > 1 ? ` (${call.runningTaskCount})` : ""}…
                        </div>
                    )}
                </div>
                <div className="w-full max-w-md space-y-3">
                    {call.phase === "blocked" &&
                        call.blockers.map((blocker) => (
                            <BlockerAlert key={blocker} blocker={blocker} />
                        ))}
                    {call.error !== null && (
                        <Alert variant="destructive">
                            <TriangleAlert />
                            <AlertTitle>The call failed</AlertTitle>
                            <AlertDescription>{call.error}</AlertDescription>
                        </Alert>
                    )}
                </div>
            </div>
            <div className="flex justify-center pb-8">
                <div className="flex items-center gap-3 rounded-full bg-background p-2 shadow-md">
                    <Button
                        variant="ghost"
                        className="size-12 rounded-full"
                        disabled={call.phase !== "connected"}
                        onClick={call.toggleMute}
                        aria-pressed={call.isMuted}
                        aria-label={call.isMuted ? "Unmute microphone" : "Mute microphone"}
                        title={call.isMuted ? "Unmute" : "Mute"}
                    >
                        {call.isMuted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
                    </Button>
                    {isInCall ? (
                        <Button
                            className="h-12 rounded-full bg-red-600 px-6 text-white hover:bg-red-700"
                            disabled={call.phase === "ending"}
                            onClick={call.hangUp}
                        >
                            <PhoneOff className="size-5" />
                            Hang up
                        </Button>
                    ) : (
                        <Button
                            className="h-12 rounded-full bg-green-600 px-6 text-white hover:bg-green-700"
                            disabled={call.phase !== "idle"}
                            onClick={call.startCall}
                        >
                            <Phone className="size-5" />
                            Call
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * The assistant's avatar: a circle with a pulsing ring while it speaks.
 *
 * @param props Speaking and call state.
 * @returns The avatar.
 */
function Avatar({
    isSpeaking,
    isInCall,
}: {
    readonly isSpeaking: boolean;
    readonly isInCall: boolean;
}) {
    return (
        <div className="relative flex size-40 items-center justify-center">
            {isSpeaking && (
                <span className="absolute inset-0 animate-ping rounded-full bg-primary/20" />
            )}
            <span
                className={cn(
                    "absolute inset-0 rounded-full border-4 transition-colors",
                    isSpeaking ? "border-primary" : "border-transparent",
                )}
            />
            <div
                className={cn(
                    "relative flex size-36 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity",
                    isInCall ? "opacity-100" : "opacity-70",
                )}
            >
                <AudioLines className="size-14" />
            </div>
        </div>
    );
}

/**
 * Status line under the name: what the call is doing, or its duration.
 *
 * @param props Phase and connect time.
 * @returns The line.
 */
function CallStatus({
    phase,
    connectedAt,
}: {
    readonly phase: CallPhase;
    readonly connectedAt: number | null;
}) {
    const now = useNow(phase === "connected");
    const text = (() => {
        switch (phase) {
            case "checking":
                return "Checking…";
            case "blocked":
                return "Calling is not available";
            case "idle":
                return "Ready to call";
            case "connecting":
                return "Calling…";
            case "connected":
                return connectedAt === null ? "Connected" : formatDuration(now - connectedAt);
            case "ending":
                return "Hanging up…";
        }
    })();
    return <div className="text-muted-foreground text-sm tabular-nums">{text}</div>;
}

/**
 * Explain why calling is not possible and how to fix it.
 *
 * @param props The blocker.
 * @returns An alert.
 */
function BlockerAlert({ blocker }: { readonly blocker: VoiceBlocker }) {
    switch (blocker) {
        case "insecureContext":
            return (
                <Alert variant="destructive">
                    <ShieldAlert />
                    <AlertTitle>Voice needs HTTPS</AlertTitle>
                    <AlertDescription>
                        Browsers only allow the microphone on secure pages. Open Familiar over HTTPS
                        — for example through its Tailscale address — or on localhost.
                    </AlertDescription>
                </Alert>
            );
        case "noApiKey":
            return (
                <Alert variant="destructive">
                    <TriangleAlert />
                    <AlertTitle>No OpenAI API key</AlertTitle>
                    <AlertDescription>
                        Voice uses OpenAI GPT-Live. On the machine running Familiar, run{" "}
                        <code>familiar config set inference.apiKeys.openai</code>, then reload this
                        page.
                    </AlertDescription>
                </Alert>
            );
        case "statusFailed":
            return (
                <Alert variant="destructive">
                    <TriangleAlert />
                    <AlertTitle>Voice is not reachable</AlertTitle>
                    <AlertDescription>
                        The voice plugin did not answer. Check that it is enabled and the daemon is
                        running, then reload this page.
                    </AlertDescription>
                </Alert>
            );
    }
}

/**
 * The current time, ticking every second while `isActive`.
 *
 * @param isActive Whether to tick.
 * @returns Milliseconds since epoch.
 */
function useNow(isActive: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!isActive) {
            return;
        }
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [isActive]);
    return now;
}

/**
 * Format a call duration as `m:ss` (or `h:mm:ss`).
 *
 * @param ms Duration.
 * @returns The formatted duration.
 */
function formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
        : `${minutes}:${seconds}`;
}
