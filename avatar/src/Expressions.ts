import type { AvatarMouthType } from "@getfamiliar/shared/avatar";
import { useEffect, useState } from "react";
import type { AvatarExpression } from "./AvatarSvg.js";

/**
 * Ready-made expressions for common situations. They only change the
 * mouth: eyes and eyebrows come in several drawing styles (dots or with
 * white, natural or bold brows), so overriding them would change the
 * configured look. The idle animation keeps the eyes alive. Plugins may
 * still set any face parts directly.
 */
export const EXPRESSION_PRESETS = {
    /** Attentive: closed smile. */
    listening: { mouth: "Twinkle" },
    /** Talking: combine with {@link useTalkingMouth} for the mouth. */
    speaking: {},
    /** Pondering: flat mouth. */
    thinking: { mouth: "Serious" },
} as const satisfies Record<string, AvatarExpression>;

/** Mouths cycled while talking: open, half open, closed. */
const TALKING_MOUTHS: readonly AvatarMouthType[] = ["Smile", "Default", "Twinkle"];

/** Shortest time a talking mouth stays. */
const TALKING_MOUTH_MIN_MS = 220;
/** Added random time a talking mouth stays (up to). */
const TALKING_MOUTH_JITTER_MS = 200;

/**
 * A mouth that keeps changing while `isTalking` — not lip sync, just
 * enough movement to look like speech.
 *
 * @param isTalking Whether the avatar talks right now.
 * @returns A mouth while talking, `undefined` otherwise.
 */
export function useTalkingMouth(isTalking: boolean): AvatarMouthType | undefined {
    const [mouth, setMouth] = useState<AvatarMouthType | undefined>(undefined);
    useEffect(() => {
        if (!isTalking) {
            setMouth(undefined);
            return;
        }
        let timer = 0;
        let current: AvatarMouthType = "Smile";
        const next = () => {
            const choices = TALKING_MOUTHS.filter((candidate) => candidate !== current);
            current = choices[Math.floor(Math.random() * choices.length)] ?? "Smile";
            setMouth(current);
            timer = window.setTimeout(
                next,
                TALKING_MOUTH_MIN_MS + Math.random() * TALKING_MOUTH_JITTER_MS,
            );
        };
        next();
        return () => window.clearTimeout(timer);
    }, [isTalking]);
    return isTalking ? mouth : undefined;
}
