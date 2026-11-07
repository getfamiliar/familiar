import type { AvatarMouthType } from "@getfamiliar/shared/avatar";
import type { PartComponent } from "../PartProps.js";
import { Concerned as ConcernedPart } from "./Concerned.js";
import { Default as DefaultPart } from "./Default.js";
import { Disbelief as DisbeliefPart } from "./Disbelief.js";
import { Eating as EatingPart } from "./Eating.js";
import { Grimace as GrimacePart } from "./Grimace.js";
import { Sad as SadPart } from "./Sad.js";
import { ScreamOpen as ScreamOpenPart } from "./ScreamOpen.js";
import { Serious as SeriousPart } from "./Serious.js";
import { Smile as SmilePart } from "./Smile.js";
import { Tongue as TonguePart } from "./Tongue.js";
import { Twinkle as TwinklePart } from "./Twinkle.js";
import { Vomit as VomitPart } from "./Vomit.js";

/** Avataaars mouth parts by option value. */
export const MOUTHS: Readonly<Record<AvatarMouthType, PartComponent>> = {
    Concerned: ConcernedPart,
    Default: DefaultPart,
    Disbelief: DisbeliefPart,
    Eating: EatingPart,
    Grimace: GrimacePart,
    Sad: SadPart,
    ScreamOpen: ScreamOpenPart,
    Serious: SeriousPart,
    Smile: SmilePart,
    Tongue: TonguePart,
    Twinkle: TwinklePart,
    Vomit: VomitPart,
};
