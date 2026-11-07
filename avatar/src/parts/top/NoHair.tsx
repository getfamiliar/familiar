import { useSvgId } from "../../SvgId.js";
import { FacialHair } from "../Fills.js";
import type { PartProps } from "../PartProps.js";

/** Avataaars part `NoHair`. */
export function NoHair(props: PartProps) {
    const filter1 = useSvgId();
    const mask1 = useSvgId();
    const path1 = useSvgId();
    return (
        <g strokeWidth="1" fillRule="evenodd">
            <defs>
                <rect id={path1} x="0" y="0" width="264" height="280" />
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
            <mask id={mask1} fill="white">
                <use href={`#${path1}`} />
            </mask>
            <g />
            <g mask={`url(#${mask1})`}>
                <g transform="translate(-1.000000, 0.000000)">
                    <FacialHair />
                    {props.children}
                </g>
            </g>
        </g>
    );
}
