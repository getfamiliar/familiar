import type { AvatarEyeType } from "@getfamiliar/shared/avatar";
import type { PartComponent } from "../PartProps.js";
import { Close as ClosePart } from "./Close.js";
import { Cry as CryPart } from "./Cry.js";
import { Default as DefaultPart } from "./Default.js";
import { Dizzy as DizzyPart } from "./Dizzy.js";
import { EyeRoll as EyeRollPart } from "./EyeRoll.js";
import { Happy as HappyPart } from "./Happy.js";
import { Hearts as HeartsPart } from "./Hearts.js";
import { Side as SidePart } from "./Side.js";
import { Squint as SquintPart } from "./Squint.js";
import { Surprised as SurprisedPart } from "./Surprised.js";
import { Wink as WinkPart } from "./Wink.js";
import { WinkWacky as WinkWackyPart } from "./WinkWacky.js";

/** Avataaars eyes parts by option value. */
export const EYES: Readonly<Record<AvatarEyeType, PartComponent>> = {
    Close: ClosePart,
    Cry: CryPart,
    Default: DefaultPart,
    Dizzy: DizzyPart,
    EyeRoll: EyeRollPart,
    Happy: HappyPart,
    Hearts: HeartsPart,
    Side: SidePart,
    Squint: SquintPart,
    Surprised: SurprisedPart,
    Wink: WinkPart,
    WinkWacky: WinkWackyPart,
};
