import type { AvatarConfig } from "@getfamiliar/shared/avatar";
import type { PartComponent } from "../PartProps.js";
import { Blank as BlankPart } from "./Blank.js";
import { Kurt as KurtPart } from "./Kurt.js";
import { Prescription01 as Prescription01Part } from "./Prescription01.js";
import { Prescription02 as Prescription02Part } from "./Prescription02.js";
import { Round as RoundPart } from "./Round.js";
import { Sunglasses as SunglassesPart } from "./Sunglasses.js";
import { Wayfarers as WayfarersPart } from "./Wayfarers.js";

/** Avataaars accessories parts by option value. */
export const ACCESSORIES: Readonly<Record<AvatarConfig["accessoriesType"], PartComponent>> = {
    Blank: BlankPart,
    Kurt: KurtPart,
    Prescription01: Prescription01Part,
    Prescription02: Prescription02Part,
    Round: RoundPart,
    Sunglasses: SunglassesPart,
    Wayfarers: WayfarersPart,
};
