import type { AvatarTopType } from "@getfamiliar/shared/avatar";
import type { PartComponent } from "../PartProps.js";
import { Eyepatch as EyepatchPart } from "./Eyepatch.js";
import { Hat as HatPart } from "./Hat.js";
import { Hijab as HijabPart } from "./Hijab.js";
import { LongHairBigHair as LongHairBigHairPart } from "./LongHairBigHair.js";
import { LongHairBob as LongHairBobPart } from "./LongHairBob.js";
import { LongHairBun as LongHairBunPart } from "./LongHairBun.js";
import { LongHairCurly as LongHairCurlyPart } from "./LongHairCurly.js";
import { LongHairCurvy as LongHairCurvyPart } from "./LongHairCurvy.js";
import { LongHairDreads as LongHairDreadsPart } from "./LongHairDreads.js";
import { LongHairFrida as LongHairFridaPart } from "./LongHairFrida.js";
import { LongHairFro as LongHairFroPart } from "./LongHairFro.js";
import { LongHairFroBand as LongHairFroBandPart } from "./LongHairFroBand.js";
import { LongHairMiaWallace as LongHairMiaWallacePart } from "./LongHairMiaWallace.js";
import { LongHairNotTooLong as LongHairNotTooLongPart } from "./LongHairNotTooLong.js";
import { LongHairShavedSides as LongHairShavedSidesPart } from "./LongHairShavedSides.js";
import { LongHairStraight as LongHairStraightPart } from "./LongHairStraight.js";
import { LongHairStraight2 as LongHairStraight2Part } from "./LongHairStraight2.js";
import { LongHairStraightStrand as LongHairStraightStrandPart } from "./LongHairStraightStrand.js";
import { NoHair as NoHairPart } from "./NoHair.js";
import { ShortHairDreads01 as ShortHairDreads01Part } from "./ShortHairDreads01.js";
import { ShortHairDreads02 as ShortHairDreads02Part } from "./ShortHairDreads02.js";
import { ShortHairFrizzle as ShortHairFrizzlePart } from "./ShortHairFrizzle.js";
import { ShortHairShaggyMullet as ShortHairShaggyMulletPart } from "./ShortHairShaggyMullet.js";
import { ShortHairShortCurly as ShortHairShortCurlyPart } from "./ShortHairShortCurly.js";
import { ShortHairShortFlat as ShortHairShortFlatPart } from "./ShortHairShortFlat.js";
import { ShortHairShortRound as ShortHairShortRoundPart } from "./ShortHairShortRound.js";
import { ShortHairShortWaved as ShortHairShortWavedPart } from "./ShortHairShortWaved.js";
import { ShortHairSides as ShortHairSidesPart } from "./ShortHairSides.js";
import { ShortHairTheCaesar as ShortHairTheCaesarPart } from "./ShortHairTheCaesar.js";
import { ShortHairTheCaesarSidePart as ShortHairTheCaesarSidePartPart } from "./ShortHairTheCaesarSidePart.js";
import { Turban as TurbanPart } from "./Turban.js";
import { WinterHat1 as WinterHat1Part } from "./WinterHat1.js";
import { WinterHat2 as WinterHat2Part } from "./WinterHat2.js";
import { WinterHat3 as WinterHat3Part } from "./WinterHat3.js";
import { WinterHat4 as WinterHat4Part } from "./WinterHat4.js";

/** Avataaars top parts by option value. */
export const TOPS: Readonly<Record<AvatarTopType, PartComponent>> = {
    Eyepatch: EyepatchPart,
    Hat: HatPart,
    Hijab: HijabPart,
    LongHairBigHair: LongHairBigHairPart,
    LongHairBob: LongHairBobPart,
    LongHairBun: LongHairBunPart,
    LongHairCurly: LongHairCurlyPart,
    LongHairCurvy: LongHairCurvyPart,
    LongHairDreads: LongHairDreadsPart,
    LongHairFrida: LongHairFridaPart,
    LongHairFro: LongHairFroPart,
    LongHairFroBand: LongHairFroBandPart,
    LongHairMiaWallace: LongHairMiaWallacePart,
    LongHairNotTooLong: LongHairNotTooLongPart,
    LongHairShavedSides: LongHairShavedSidesPart,
    LongHairStraight: LongHairStraightPart,
    LongHairStraight2: LongHairStraight2Part,
    LongHairStraightStrand: LongHairStraightStrandPart,
    NoHair: NoHairPart,
    ShortHairDreads01: ShortHairDreads01Part,
    ShortHairDreads02: ShortHairDreads02Part,
    ShortHairFrizzle: ShortHairFrizzlePart,
    ShortHairShaggyMullet: ShortHairShaggyMulletPart,
    ShortHairShortCurly: ShortHairShortCurlyPart,
    ShortHairShortFlat: ShortHairShortFlatPart,
    ShortHairShortRound: ShortHairShortRoundPart,
    ShortHairShortWaved: ShortHairShortWavedPart,
    ShortHairSides: ShortHairSidesPart,
    ShortHairTheCaesar: ShortHairTheCaesarPart,
    ShortHairTheCaesarSidePart: ShortHairTheCaesarSidePartPart,
    Turban: TurbanPart,
    WinterHat1: WinterHat1Part,
    WinterHat2: WinterHat2Part,
    WinterHat3: WinterHat3Part,
    WinterHat4: WinterHat4Part,
};
