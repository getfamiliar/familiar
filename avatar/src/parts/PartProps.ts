import type { ReactNode } from "react";

/** Props of an Avataaars part. */
export interface PartProps {
    /** Mask a color fill or graphic is clipped to. */
    readonly maskID?: string;
    /** Nested parts (accessories inside a top). */
    readonly children?: ReactNode;
}

/** One selectable Avataaars part. */
export type PartComponent = (props: PartProps) => ReactNode;
