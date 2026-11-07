import { useSvgId } from "../../SvgId.js";
import { FacialHair, HairColor } from "../Fills.js";
import type { PartProps } from "../PartProps.js";

/** Avataaars part `ShortHairFrizzle`. */
export function ShortHairFrizzle(props: PartProps) {
    const filter1 = useSvgId();
    const mask1 = useSvgId();
    const mask2 = useSvgId();
    const path1 = useSvgId();
    const path2 = useSvgId();
    return (
        <g strokeWidth="1" fillRule="evenodd">
            <defs>
                <rect id={path2} x="0" y="0" width="264" height="280" />
                <path
                    d="M90.9102919,55.3613196 L175.085702,55.3613196 C193.333279,44.8338001 196.759397,26.1510357 183.849606,9.92600089 C180.635746,5.88682054 175.085702,21.6755614 158.028596,22.6504878 C140.97149,23.6254143 142.608865,16.3498661 124.45759,19.0739248 C106.306316,21.7979835 108.311575,36.37843 96.4671989,39.8768239 C88.5709482,42.2090865 86.7186458,47.370585 90.9102919,55.3613196 Z"
                    id={path1}
                />
                <filter
                    x="-0.8%"
                    y="-2.0%"
                    width="101.5%"
                    height="108.0%"
                    filterUnits="objectBoundingBox"
                    id={filter1}
                >
                    <feOffset dx="0" dy="2" in="SourceAlpha" result="shadowOffsetOuter1" />
                    <feColorMatrix
                        values="0 0 0 0 0   0 0 0 0 0   0 0 0 0 0  0 0 0 0.16 0"
                        type="matrix"
                        in="shadowOffsetOuter1"
                        result="shadowMatrixOuter1"
                    />
                    <feMerge>
                        <feMergeNode in="shadowMatrixOuter1" />
                        <feMergeNode in="SourceGraphic" />
                    </feMerge>
                </filter>
            </defs>
            <mask id={mask2} fill="white">
                <use href={`#${path2}`} />
            </mask>
            <g />
            <g mask={`url(#${mask2})`}>
                <g transform="translate(-1.000000, 0.000000)">
                    <FacialHair />
                    <mask id={mask1} fill="white">
                        <use href={`#${path1}`} />
                    </mask>
                    <use stroke="none" fill="#252E32" fillRule="evenodd" href={`#${path1}`} />
                    <HairColor maskID={mask1} />
                    {props.children}
                </g>
            </g>
        </g>
    );
}
