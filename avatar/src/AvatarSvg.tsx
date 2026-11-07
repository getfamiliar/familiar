import type {
    AvatarConfig,
    AvatarEyebrowType,
    AvatarEyeType,
    AvatarMouthType,
} from "@getfamiliar/shared/avatar";
import type { CSSProperties, ReactNode, Ref } from "react";
import { AvatarContext } from "./AvatarContext.js";
import { ACCESSORIES } from "./parts/accessories/index.js";
import { CLOTHES } from "./parts/clothes/index.js";
import { EYEBROWS } from "./parts/eyebrows/index.js";
import { EYES } from "./parts/eyes/index.js";
import { SkinColor } from "./parts/Fills.js";
import { MOUTHS } from "./parts/mouth/index.js";
import { Default as Nose } from "./parts/nose/Default.js";
import { TOPS } from "./parts/top/index.js";
import { useSvgId } from "./SvgId.js";

/** Face parts set from outside, overriding the configured ones (e.g. "speaking"). */
export interface AvatarExpression {
    readonly eyes?: AvatarEyeType;
    readonly eyebrows?: AvatarEyebrowType;
    readonly mouth?: AvatarMouthType;
}

/** Props shared by {@link AvatarSvg} and the animated `Avatar`. */
export interface AvatarDisplayProps {
    /** The avatar to draw. */
    readonly config: AvatarConfig;
    /** Face parts overriding the configured ones. */
    readonly expression?: AvatarExpression;
    /** Accessible name (also rendered as `<title>`). */
    readonly title?: string;
    /** Section of the 264×280 drawing to show (default: all of it), e.g. a face close-up. */
    readonly viewBox?: string;
    readonly className?: string;
    readonly style?: CSSProperties;
}

/** What goes into the face: one node per exchangeable part. */
export interface AvatarFaceSlots {
    readonly eyes: ReactNode;
    readonly eyebrows: ReactNode;
    readonly mouth: ReactNode;
}

/** The whole drawing. */
const FULL_VIEW_BOX = "0 0 264 280";

/** Outline of head and neck (Avataaars body path). */
const HEAD_AND_NECK_PATH =
    "M124,144.610951 L124,163 L128,163 L128,163 C167.764502,163 200,195.235498 200,235 L200,244 L0,244 L0,235 C-4.86974701e-15,195.235498 32.235498,163 72,163 L72,163 L76,163 L76,144.610951 C58.7626345,136.422372 46.3722246,119.687011 44.3051388,99.8812385 C38.4803105,99.0577866 34,94.0521096 34,88 L34,74 C34,68.0540074 38.3245733,63.1180731 44,62.1659169 L44,56 L44,56 C44,25.072054 69.072054,5.68137151e-15 100,0 L100,0 L100,0 C130.927946,-5.68137151e-15 156,25.072054 156,56 L156,62.1659169 C161.675427,63.1180731 166,68.0540074 166,74 L166,88 C166,94.0521096 161.51969,99.0577866 155.694861,99.8812385 C153.627775,119.687011 141.237365,136.422372 124,144.610951 Z";

/** Shadow the head casts onto the neck. */
const NECK_SHADOW_PATH =
    "M156,79 L156,102 C156,132.927946 130.927946,158 100,158 C69.072054,158 44,132.927946 44,102 L44,79 L44,94 C44,124.927946 69.072054,150 100,150 C130.927946,150 156,124.927946 156,94 L156,79 Z";

/**
 * Head and neck in the skin color.
 *
 * @returns The body group.
 */
function HeadAndNeck() {
    const path = useSvgId();
    const mask = useSvgId();
    return (
        <g transform="translate(32, 36)">
            <defs>
                <path d={HEAD_AND_NECK_PATH} id={path} />
            </defs>
            <mask id={mask} fill="white">
                <use href={`#${path}`} />
            </mask>
            <use fill="#D0C6AC" href={`#${path}`} />
            <SkinColor maskID={mask} />
            <path d={NECK_SHADOW_PATH} fillOpacity="0.1" fill="#000000" mask={`url(#${mask})`} />
        </g>
    );
}

/**
 * A group moving with the head: wrapped in the two sway groups when
 * `animated`, plain otherwise.
 *
 * @param props.isAnimated Whether the head sways.
 * @param props.children Content.
 * @returns The group.
 */
function HeadGroup({
    isAnimated,
    children,
}: {
    readonly isAnimated: boolean;
    readonly children: ReactNode;
}) {
    if (!isAnimated) {
        return <g>{children}</g>;
    }
    return (
        <g className="fa-head">
            <g className="fa-head-inner">{children}</g>
        </g>
    );
}

/**
 * Height where the skin is split into turning head and still shoulders:
 * just above the shoulders, where the skin is only the narrow neck, so
 * turning around the pivot (neck base, y 200) moves the cut by well
 * under a pixel.
 */
const SKIN_SPLIT_Y = 190;

/**
 * Skin for the animated avatar. Head, neck and shoulders are one path
 * that continues under the clothes, so turning all of it would push the
 * shoulders out from under the (static) clothes. It is drawn twice
 * instead: above {@link SKIN_SPLIT_Y} turning with the head, below it
 * still. The two halves overlap by a pixel so no seam shows.
 *
 * @returns The skin groups.
 */
function SwayingSkin() {
    const headClip = useSvgId();
    const shoulderClip = useSvgId();
    return (
        <>
            <defs>
                <clipPath id={headClip}>
                    <rect x="0" y="0" width="264" height={SKIN_SPLIT_Y + 1} />
                </clipPath>
                <clipPath id={shoulderClip}>
                    <rect x="0" y={SKIN_SPLIT_Y - 1} width="264" height={280 - SKIN_SPLIT_Y + 1} />
                </clipPath>
            </defs>
            <g clipPath={`url(#${headClip})`}>
                <HeadGroup isAnimated>
                    <HeadAndNeck />
                </HeadGroup>
            </g>
            <g clipPath={`url(#${shoulderClip})`}>
                <HeadAndNeck />
            </g>
        </>
    );
}

/**
 * The avatar drawing (viewBox 264×280) with exchangeable face slots.
 * Clothes are drawn between head and face, so the moving head is two
 * groups that sway in sync (see {@link SwayingSkin} for the first).
 *
 * @param props Avatar, face slots, animation hooks and SVG attributes.
 * @returns The SVG element.
 */
export function AvatarDrawing({
    config,
    face,
    isAnimated,
    head,
    title,
    viewBox,
    className,
    style,
    svgRef,
}: {
    readonly config: AvatarConfig;
    readonly face: AvatarFaceSlots;
    readonly isAnimated: boolean;
    /** Extra content in front of the drawing (the animation stylesheet). */
    readonly head?: ReactNode;
    readonly title?: string;
    readonly viewBox?: string;
    readonly className?: string;
    readonly style?: CSSProperties;
    readonly svgRef?: Ref<SVGSVGElement>;
}) {
    const Top = TOPS[config.topType];
    const Accessory = ACCESSORIES[config.accessoriesType];
    const Clothes = CLOTHES[config.clotheType];
    return (
        <svg
            ref={svgRef}
            xmlns="http://www.w3.org/2000/svg"
            viewBox={viewBox ?? FULL_VIEW_BOX}
            className={className}
            style={style}
            role="img"
            aria-label={title}
        >
            {title !== undefined && <title>{title}</title>}
            {head}
            <rect x="0" y="0" width="264" height="280" fill={config.backgroundColor} />
            <AvatarContext.Provider value={config}>
                <g stroke="none" strokeWidth="1" fill="none" fillRule="evenodd">
                    {isAnimated ? <SwayingSkin /> : <HeadAndNeck />}
                    <Clothes />
                    <HeadGroup isAnimated={isAnimated}>
                        <g transform="translate(76, 82)" fill="#000000">
                            {face.mouth}
                            <Nose />
                            {face.eyes}
                            {face.eyebrows}
                        </g>
                        <Top>
                            <Accessory />
                        </Top>
                    </HeadGroup>
                </g>
            </AvatarContext.Provider>
        </svg>
    );
}

/**
 * The avatar as a static SVG: no animation, suitable for small icons and
 * for {@link avatarToSvgMarkup}.
 *
 * @param props Avatar, optional expression and SVG attributes.
 * @returns The SVG element.
 */
export function AvatarSvg({
    config,
    expression,
    title,
    viewBox,
    className,
    style,
}: AvatarDisplayProps) {
    const Eyes = EYES[expression?.eyes ?? config.eyeType];
    const Eyebrows = EYEBROWS[expression?.eyebrows ?? config.eyebrowType];
    const Mouth = MOUTHS[expression?.mouth ?? config.mouthType];
    return (
        <AvatarDrawing
            config={config}
            face={{ eyes: <Eyes />, eyebrows: <Eyebrows />, mouth: <Mouth /> }}
            isAnimated={false}
            title={title}
            viewBox={viewBox}
            className={className}
            style={style}
        />
    );
}
