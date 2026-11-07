import type { AvatarConfig } from "@getfamiliar/shared/avatar";
import type { PartComponent } from "../PartProps.js";
import { Bat as BatPart } from "./Bat.js";
import { Bear as BearPart } from "./Bear.js";
import { Cumbia as CumbiaPart } from "./Cumbia.js";
import { Deer as DeerPart } from "./Deer.js";
import { Diamond as DiamondPart } from "./Diamond.js";
import { Hola as HolaPart } from "./Hola.js";
import { Pizza as PizzaPart } from "./Pizza.js";
import { Resist as ResistPart } from "./Resist.js";
import { Selena as SelenaPart } from "./Selena.js";
import { Skull as SkullPart } from "./Skull.js";
import { SkullOutline as SkullOutlinePart } from "./SkullOutline.js";

/** Avataaars graphics parts by option value. */
export const GRAPHICS: Readonly<Record<AvatarConfig["graphicType"], PartComponent>> = {
    Bat: BatPart,
    Bear: BearPart,
    Cumbia: CumbiaPart,
    Deer: DeerPart,
    Diamond: DiamondPart,
    Hola: HolaPart,
    Pizza: PizzaPart,
    Resist: ResistPart,
    Selena: SelenaPart,
    Skull: SkullPart,
    SkullOutline: SkullOutlinePart,
};
