import { useSvgId } from "../../SvgId.js";

/** Avataaars part `Squint`. */
export function Squint() {
    const path1 = useSvgId();
    const path2 = useSvgId();
    const mask1 = useSvgId();
    const mask2 = useSvgId();
    return (
        <g transform="translate(0.000000, 8.000000)">
            <defs>
                <path
                    d="M14,14.0481187 C23.6099827,14.0481187 28,18.4994466 28,11.5617716 C28,4.62409673 21.7319865,0 14,0 C6.2680135,0 0,4.62409673 0,11.5617716 C0,18.4994466 4.39001726,14.0481187 14,14.0481187 Z"
                    id={path1}
                />
                <path
                    d="M14,14.0481187 C23.6099827,14.0481187 28,18.4994466 28,11.5617716 C28,4.62409673 21.7319865,0 14,0 C6.2680135,0 0,4.62409673 0,11.5617716 C0,18.4994466 4.39001726,14.0481187 14,14.0481187 Z"
                    id={path2}
                />
            </defs>
            <g transform="translate(16.000000, 13.000000)">
                <mask id={mask1} fill="white">
                    <use href={`#${path1}`} />
                </mask>
                <use fill="#FFFFFF" href={`#${path1}`} />
                <circle
                    fillOpacity="0.699999988"
                    fill="#000000"
                    mask={`url(#${mask1})`}
                    cx="14"
                    cy="10"
                    r="6"
                />
            </g>
            <g transform="translate(68.000000, 13.000000)">
                <mask id={mask2} fill="white">
                    <use href={`#${path2}`} />
                </mask>
                <use fill="#FFFFFF" href={`#${path2}`} />
                <circle
                    fillOpacity="0.699999988"
                    fill="#000000"
                    mask={`url(#${mask2})`}
                    cx="14"
                    cy="10"
                    r="6"
                />
            </g>
        </g>
    );
}
