import type { AvatarConfig } from "@getfamiliar/shared/avatar";
import type { PartComponent } from "../PartProps.js";
import { BeardLight as BeardLightPart } from "./BeardLight.js";
import { BeardMajestic as BeardMajesticPart } from "./BeardMajestic.js";
import { BeardMedium as BeardMediumPart } from "./BeardMedium.js";
import { Blank as BlankPart } from "./Blank.js";
import { MoustacheFancy as MoustacheFancyPart } from "./MoustacheFancy.js";
import { MoustacheMagnum as MoustacheMagnumPart } from "./MoustacheMagnum.js";

/** Avataaars facial-hair parts by option value. */
export const FACIAL_HAIRS: Readonly<Record<AvatarConfig["facialHairType"], PartComponent>> = {
    BeardLight: BeardLightPart,
    BeardMajestic: BeardMajesticPart,
    BeardMedium: BeardMediumPart,
    Blank: BlankPart,
    MoustacheFancy: MoustacheFancyPart,
    MoustacheMagnum: MoustacheMagnumPart,
};
