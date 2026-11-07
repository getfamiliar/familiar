import { useAvatarConfig } from "../AvatarContext.js";
import { FABRIC_COLORS, FACIAL_HAIR_COLORS, HAIR_COLORS, SKIN_COLORS } from "../Colors.js";
import { FACIAL_HAIRS } from "./facial-hair/index.js";
import { GRAPHICS } from "./graphics/index.js";
import type { PartProps } from "./PartProps.js";

/**
 * A full-size rectangle in `color`, clipped to the part's mask.
 *
 * @param props.maskID Mask of the part.
 * @param props.color Fill color.
 * @returns The fill.
 */
function ColorFill({ maskID, color }: { readonly maskID?: string; readonly color: string }) {
    return (
        <g mask={`url(#${maskID})`} fill={color} fillRule="evenodd">
            <rect x="0" y="0" width="264" height="280" />
        </g>
    );
}

/** Skin color of the head and neck. */
export function SkinColor({ maskID }: PartProps) {
    return <ColorFill maskID={maskID} color={SKIN_COLORS[useAvatarConfig().skinColor]} />;
}

/** Hair color of the current top. */
export function HairColor({ maskID }: PartProps) {
    return <ColorFill maskID={maskID} color={HAIR_COLORS[useAvatarConfig().hairColor]} />;
}

/** Fabric color of the current hat. */
export function HatColor({ maskID }: PartProps) {
    return <ColorFill maskID={maskID} color={FABRIC_COLORS[useAvatarConfig().hatColor]} />;
}

/** Fabric color of the current clothes. */
export function ClotheColor({ maskID }: PartProps) {
    return <ColorFill maskID={maskID} color={FABRIC_COLORS[useAvatarConfig().clotheColor]} />;
}

/** Color of the current facial hair. */
export function FacialHairColor({ maskID }: PartProps) {
    return (
        <ColorFill maskID={maskID} color={FACIAL_HAIR_COLORS[useAvatarConfig().facialHairColor]} />
    );
}

/** The graphic printed on a graphic shirt. */
export function Graphic({ maskID }: PartProps) {
    const Part = GRAPHICS[useAvatarConfig().graphicType];
    return <Part maskID={maskID} />;
}

/** The configured facial hair (drawn by every top). */
export function FacialHair() {
    const Part = FACIAL_HAIRS[useAvatarConfig().facialHairType];
    return <Part />;
}
