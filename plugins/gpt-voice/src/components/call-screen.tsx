import {
    Avatar,
    type AvatarExpression,
    EXPRESSION_PRESETS,
    useTalkingMouth,
} from "@getfamiliar/avatar";
import type { WebAssistantIdentity } from "@getfamiliar/shared";
import { Mic, MicOff, Phone, PhoneOff, ShieldAlert, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Laptop } from "@/components/laptop";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { type CallPhase, useVoiceCall, type VoiceBlocker } from "@/hooks/use-voice-call";
import { cn } from "@/lib/utils";

/** Props of {@link CallScreen}. */
export interface CallScreenProps {
    /** Plugin route prefix (`/plugins/gpt-voice`). */
    readonly basePath: string;
    /** The assistant's name and avatar. */
    readonly assistant: WebAssistantIdentity;
}

/**
 * The call screen, modelled on a video-call app: the assistant's animated
 * face in the middle, name, status and call duration below, and a control
 * bar with mute and call / hang-up at the bottom.
 *
 * @param props Route prefix and assistant.
 * @returns The screen.
 */
export function CallScreen({ basePath, assistant }: CallScreenProps) {
    const call = useVoiceCall(basePath);
    const isInCall =
        call.phase === "connecting" || call.phase === "connected" || call.phase === "ending";
    return (
        <div className="flex h-full min-h-[480px] flex-col bg-muted/40">
            <div className="@container flex flex-1 flex-col items-center justify-center gap-6 p-6">
                <AssistantFace
                    assistant={assistant}
                    isLive={call.phase === "connected"}
                    isSpeaking={call.isAssistantSpeaking}
                    isBusy={call.runningTaskCount > 0}
                />
                <div className="flex flex-col items-center gap-1 text-center">
                    <div className="font-heading text-xl font-medium">{assistant.name}</div>
                    <CallStatus
                        phase={call.phase}
                        connectedAt={call.connectedAt}
                        isBriefingLoading={call.isBriefingLoading}
                    />
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

/** Where the assistant looks while it works on the laptop. */
const LOOK_AT_LAPTOP = { x: 0, y: 4 } as const;

/**
 * The assistant's face. Before a call it rests in a circle: still,
 * faded, half desaturated. Once the call runs (the duration shows), the
 * circle grows into a 16:9 video tile like in a video call, the avatar
 * grows with it (head and shoulders, like a webcam) and comes to life: it
 * idles (head sway, blinks, glances) and changes its expression —
 * listening, talking while it speaks. While background work runs, a
 * laptop slides into the picture and the assistant looks down into it
 * (unless it is speaking). A ring shows when it speaks.
 *
 * @param props Avatar and call state.
 * @returns The tile.
 */
function AssistantFace({
    assistant,
    isLive,
    isSpeaking,
    isBusy,
}: {
    readonly assistant: WebAssistantIdentity;
    readonly isLive: boolean;
    readonly isSpeaking: boolean;
    readonly isBusy: boolean;
}) {
    const talkingMouth = useTalkingMouth(isLive && isSpeaking);
    const isWorking = isLive && isBusy;
    const expression: AvatarExpression | undefined = !isLive
        ? undefined
        : isSpeaking
          ? { ...EXPRESSION_PRESETS.speaking, mouth: talkingMouth }
          : isBusy
            ? EXPRESSION_PRESETS.thinking
            : EXPRESSION_PRESETS.listening;
    return (
        <div
            className={cn(
                "relative shrink-0 overflow-hidden shadow-md ring-4 transition-all duration-700 ease-in-out",
                isLive
                    ? "h-[calc(min(100cqw,48rem)*9/16)] w-[min(100cqw,48rem)] rounded-2xl"
                    : "size-56 rounded-[50%] opacity-90 grayscale-50",
                isSpeaking ? "ring-primary" : "ring-transparent",
            )}
            style={{ backgroundColor: assistant.avatar.backgroundColor }}
        >
            <div className="absolute top-0 left-1/2 aspect-[264/280] h-full -translate-x-1/2">
                <Avatar
                    config={assistant.avatar}
                    expression={expression}
                    gaze={isWorking && !isSpeaking ? LOOK_AT_LAPTOP : undefined}
                    title={assistant.name}
                    animated={isLive}
                    className="block size-full"
                />
            </div>
            <Laptop
                isVisible={isWorking}
                className="absolute bottom-0 left-1/2 h-[30%] -translate-x-1/2"
            />
            <span className="sr-only" aria-live="polite">
                {isWorking ? `${assistant.name} is working in the background` : ""}
            </span>
        </div>
    );
}

/**
 * Status line under the name: what the call is doing, or its duration.
 *
 * @param props Phase, connect time and whether the briefing is still being built.
 * @returns The line.
 */
function CallStatus({
    phase,
    connectedAt,
    isBriefingLoading,
}: {
    readonly phase: CallPhase;
    readonly connectedAt: number | null;
    readonly isBriefingLoading: boolean;
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
    return (
        <div className="text-muted-foreground text-sm tabular-nums">
            {text}
            {phase === "connected" && isBriefingLoading && " · preparing briefing…"}
        </div>
    );
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
