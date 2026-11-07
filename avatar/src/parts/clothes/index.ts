import type { AvatarConfig } from "@getfamiliar/shared/avatar";
import type { PartComponent } from "../PartProps.js";
import { BlazerShirt as BlazerShirtPart } from "./BlazerShirt.js";
import { BlazerSweater as BlazerSweaterPart } from "./BlazerSweater.js";
import { CollarSweater as CollarSweaterPart } from "./CollarSweater.js";
import { GraphicShirt as GraphicShirtPart } from "./GraphicShirt.js";
import { Hoodie as HoodiePart } from "./Hoodie.js";
import { Overall as OverallPart } from "./Overall.js";
import { ShirtCrewNeck as ShirtCrewNeckPart } from "./ShirtCrewNeck.js";
import { ShirtScoopNeck as ShirtScoopNeckPart } from "./ShirtScoopNeck.js";
import { ShirtVNeck as ShirtVNeckPart } from "./ShirtVNeck.js";

/** Avataaars clothes parts by option value. */
export const CLOTHES: Readonly<Record<AvatarConfig["clotheType"], PartComponent>> = {
    BlazerShirt: BlazerShirtPart,
    BlazerSweater: BlazerSweaterPart,
    CollarSweater: CollarSweaterPart,
    GraphicShirt: GraphicShirtPart,
    Hoodie: HoodiePart,
    Overall: OverallPart,
    ShirtCrewNeck: ShirtCrewNeckPart,
    ShirtScoopNeck: ShirtScoopNeckPart,
    ShirtVNeck: ShirtVNeckPart,
};
