import type { AvatarEyeType } from "@getfamiliar/shared/avatar";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { type AvatarDisplayProps, AvatarDrawing } from "./AvatarSvg.js";
import { EYEBROWS } from "./parts/eyebrows/index.js";
import { EYES } from "./parts/eyes/index.js";
import { MOUTHS } from "./parts/mouth/index.js";

/** Props of the live {@link Avatar}. */
export interface AvatarProps extends AvatarDisplayProps {
    /**
     * Idle animation: head sway, eye movements, blinks, brow lifts.
     * Default `true`; always off under `prefers-reduced-motion`.
     * Expression changes crossfade either way.
     */
    readonly animated?: boolean;
    /**
     * Where the avatar looks, as an offset of the eyes in drawing units
     * (about ±4; `{ x: 0, y: 4 }` is down). The head follows a little.
     * While set, the idle glances pause. Unset: at the viewer.
     */
    readonly gaze?: AvatarGaze;
}

/** Direction of the avatar's look (see {@link AvatarProps.gaze}). */
export interface AvatarGaze {
    readonly x: number;
    readonly y: number;
}

/** How far the head follows the eyes. */
const HEAD_FOLLOWS_GAZE = 0.6;

/** Eyes that look around (the others have a fixed gaze). */
const GAZING_EYES: ReadonlySet<AvatarEyeType> = new Set(["Default", "Squint", "Surprised", "Cry"]);

/** Eyes that blink. */
const BLINKING_EYES: ReadonlySet<AvatarEyeType> = new Set([
    "Default",
    "Squint",
    "Surprised",
    "Cry",
    "Side",
    "EyeRoll",
]);

/** Crossfade duration of eyes and eyebrows. */
const FACE_FADE_MS = 140;
/** Crossfade duration of the mouth (shorter, it changes often while talking). */
const MOUTH_FADE_MS = 110;

/**
 * Stylesheet of the animation. The class names are prefixed and the rules
 * identical for every avatar, so several avatars on one page share them.
 * The pivot of the head is the base of the neck.
 */
const ANIMATION_CSS = `
.fa-head, .fa-head-inner { transform-box: view-box; transform-origin: 132px 200px; }
.fa-head { translate: var(--fa-head-x, 0px) var(--fa-head-y, 0px); transition: translate 450ms ease-in-out; }
.fa-animated .fa-head { animation: fa-sway-a 7.3s ease-in-out infinite alternate; }
.fa-animated .fa-head-inner { animation: fa-sway-b 11.9s ease-in-out infinite alternate; }
@keyframes fa-sway-a { from { transform: rotate(-1.3deg); } to { transform: rotate(1.3deg); } }
@keyframes fa-sway-b { from { transform: translate(-0.8px, 0.5px) rotate(0.7deg); } to { transform: translate(0.8px, -0.5px) rotate(-0.7deg); } }
.fa-gaze { transform: translate(var(--fa-gaze-x, 0px), var(--fa-gaze-y, 0px)); transition: transform 200ms ease-out; }
.fa-blink { transform-box: fill-box; transform-origin: center; transition: transform 70ms ease-in; }
.fa-blinking .fa-blink { transform: scaleY(0.1); }
.fa-brows { transform: translateY(var(--fa-brow-y, 0px)); transition: transform 280ms ease-out; }
.fa-fade-in { animation: fa-fade-in ease-out both; }
.fa-fade-out { animation: fa-fade-out ease-in both; }
@keyframes fa-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes fa-fade-out { from { opacity: 1; } to { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .fa-animated .fa-head, .fa-animated .fa-head-inner { animation: none; }
}
`;

/**
 * Show `value` via `render`; when it changes, the old rendering fades out
 * while the new one fades in.
 *
 * @param props.value Current value.
 * @param props.render Draws one value.
 * @param props.durationMs Fade duration.
 * @returns The layers.
 */
function Crossfade<T extends string>({
    value,
    render,
    durationMs,
}: {
    readonly value: T;
    readonly render: (value: T) => ReactNode;
    readonly durationMs: number;
}) {
    const [layers, setLayers] = useState<readonly { value: T; id: number }[]>([{ value, id: 0 }]);
    const newest = layers[layers.length - 1];
    if (newest !== undefined && newest.value !== value) {
        // Derive during render: the new part shows in the same frame.
        setLayers([newest, { value, id: newest.id + 1 }]);
    }
    useEffect(() => {
        if (layers.length < 2) {
            return;
        }
        const timer = window.setTimeout(() => setLayers((now) => now.slice(-1)), durationMs);
        return () => window.clearTimeout(timer);
    }, [layers, durationMs]);
    return layers.map((layer, index) => {
        const isFading = layers.length > 1;
        const fadeClass = index === layers.length - 1 ? "fa-fade-in" : "fa-fade-out";
        return (
            <g
                key={layer.id}
                className={isFading ? fadeClass : undefined}
                style={isFading ? { animationDuration: `${durationMs}ms` } : undefined}
            >
                {render(layer.value)}
            </g>
        );
    });
}

/**
 * A random number in `[min, max)`.
 *
 * @param min Lower bound.
 * @param max Upper bound.
 * @returns The number.
 */
function randomBetween(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

/**
 * Drive the idle animation: sets CSS variables and a blink class on the
 * SVG element from a few timers, so React does not re-render for it.
 *
 * @param svgRef The avatar's SVG element.
 * @param eyesRef Currently shown eyes (decides gaze and blinks).
 * @param gazeRef Pinned look direction; while set, no glances.
 * @param isActive Whether to animate.
 */
function useIdleAnimation(
    svgRef: RefObject<SVGSVGElement | null>,
    eyesRef: RefObject<AvatarEyeType>,
    gazeRef: RefObject<AvatarGaze | undefined>,
    isActive: boolean,
): void {
    useEffect(() => {
        const svg = svgRef.current;
        if (svg === null || !isActive) {
            return;
        }
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
            return;
        }
        const timers = new Set<number>();
        const later = (delayMs: number, action: () => void) => {
            const timer = window.setTimeout(() => {
                timers.delete(timer);
                action();
            }, delayMs);
            timers.add(timer);
        };
        const setGaze = (x: number, y: number) => setEyeGaze(svg, x, y);
        const lookAround = () => {
            if (gazeRef.current !== undefined) {
                later(randomBetween(1500, 4200), lookAround);
                return;
            }
            const isLookingAway = GAZING_EYES.has(eyesRef.current) && Math.random() < 0.45;
            setGaze(
                isLookingAway ? randomBetween(-3, 3) : 0,
                isLookingAway ? randomBetween(-1.5, 1.5) : 0,
            );
            later(randomBetween(1500, 4200), lookAround);
        };
        const closeEyes = (durationMs: number, then?: () => void) => {
            svg.classList.add("fa-blinking");
            later(durationMs, () => {
                svg.classList.remove("fa-blinking");
                then?.();
            });
        };
        const blink = () => {
            if (BLINKING_EYES.has(eyesRef.current)) {
                const isDouble = Math.random() < 0.15;
                closeEyes(110, isDouble ? () => later(140, () => closeEyes(100)) : undefined);
            }
            later(randomBetween(2800, 6500), blink);
        };
        const liftBrows = () => {
            svg.style.setProperty("--fa-brow-y", "-2px");
            later(randomBetween(500, 900), () => svg.style.setProperty("--fa-brow-y", "0px"));
            later(randomBetween(6000, 14000), liftBrows);
        };
        later(randomBetween(800, 2000), lookAround);
        later(randomBetween(1500, 3500), blink);
        later(randomBetween(5000, 9000), liftBrows);
        return () => {
            for (const timer of timers) {
                window.clearTimeout(timer);
            }
            svg.classList.remove("fa-blinking");
            setGaze(gazeRef.current?.x ?? 0, gazeRef.current?.y ?? 0);
            svg.style.setProperty("--fa-brow-y", "0px");
        };
    }, [svgRef, eyesRef, gazeRef, isActive]);
}

/**
 * Move the eyes (CSS variables read by the animation stylesheet).
 *
 * @param svg The avatar's SVG element.
 * @param x Horizontal offset in drawing units.
 * @param y Vertical offset in drawing units.
 */
function setEyeGaze(svg: SVGSVGElement, x: number, y: number): void {
    svg.style.setProperty("--fa-gaze-x", `${x.toFixed(1)}px`);
    svg.style.setProperty("--fa-gaze-y", `${y.toFixed(1)}px`);
}

/**
 * Apply a pinned look direction: eyes there, head following a little;
 * back to the viewer when unset.
 *
 * @param svgRef The avatar's SVG element.
 * @param gaze The direction, or undefined.
 */
function usePinnedGaze(
    svgRef: RefObject<SVGSVGElement | null>,
    gaze: AvatarGaze | undefined,
): void {
    const x = gaze?.x ?? 0;
    const y = gaze?.y ?? 0;
    useEffect(() => {
        const svg = svgRef.current;
        if (svg === null) {
            return;
        }
        setEyeGaze(svg, x, y);
        svg.style.setProperty("--fa-head-x", `${(x * HEAD_FOLLOWS_GAZE).toFixed(1)}px`);
        svg.style.setProperty("--fa-head-y", `${(y * HEAD_FOLLOWS_GAZE).toFixed(1)}px`);
    }, [svgRef, x, y]);
}

/**
 * The live avatar: crossfades eyes, eyebrows and mouth when the
 * `expression` changes and, when `animated`, idles like someone
 * watching — the head sways slightly, the eyes look around and blink,
 * the brows lift now and then. Without `animated` it is an
 * {@link AvatarSvg} whose expression changes still fade.
 *
 * @param props Avatar, expression, animation switch and SVG attributes.
 * @returns The SVG element.
 */
export function Avatar({
    config,
    expression,
    animated = true,
    gaze,
    title,
    viewBox,
    className,
    style,
}: AvatarProps) {
    const svgRef = useRef<SVGSVGElement>(null);
    const eyes = expression?.eyes ?? config.eyeType;
    const eyebrows = expression?.eyebrows ?? config.eyebrowType;
    const mouth = expression?.mouth ?? config.mouthType;
    const eyesRef = useRef<AvatarEyeType>(eyes);
    eyesRef.current = eyes;
    const gazeRef = useRef<AvatarGaze | undefined>(gaze);
    gazeRef.current = gaze;
    useIdleAnimation(svgRef, eyesRef, gazeRef, animated);
    usePinnedGaze(svgRef, gaze);
    return (
        <AvatarDrawing
            svgRef={svgRef}
            config={config}
            isAnimated={animated}
            head={<style>{ANIMATION_CSS}</style>}
            title={title}
            viewBox={viewBox}
            className={[animated ? "fa-animated" : undefined, className]
                .filter((name) => name !== undefined)
                .join(" ")}
            style={style}
            face={{
                eyes: (
                    <g className="fa-gaze">
                        <g className="fa-blink">
                            <Crossfade
                                value={eyes}
                                durationMs={FACE_FADE_MS}
                                render={(value) => {
                                    const Part = EYES[value];
                                    return <Part />;
                                }}
                            />
                        </g>
                    </g>
                ),
                eyebrows: (
                    <g className="fa-brows">
                        <Crossfade
                            value={eyebrows}
                            durationMs={FACE_FADE_MS}
                            render={(value) => {
                                const Part = EYEBROWS[value];
                                return <Part />;
                            }}
                        />
                    </g>
                ),
                mouth: (
                    <Crossfade
                        value={mouth}
                        durationMs={MOUTH_FADE_MS}
                        render={(value) => {
                            const Part = MOUTHS[value];
                            return <Part />;
                        }}
                    />
                ),
            }}
        />
    );
}
