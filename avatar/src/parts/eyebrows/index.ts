import type { AvatarEyebrowType } from "@getfamiliar/shared/avatar";
import type { PartComponent } from "../PartProps.js";
import { Angry as AngryPart } from "./Angry.js";
import { AngryNatural as AngryNaturalPart } from "./AngryNatural.js";
import { Default as DefaultPart } from "./Default.js";
import { DefaultNatural as DefaultNaturalPart } from "./DefaultNatural.js";
import { FlatNatural as FlatNaturalPart } from "./FlatNatural.js";
import { FrownNatural as FrownNaturalPart } from "./FrownNatural.js";
import { RaisedExcited as RaisedExcitedPart } from "./RaisedExcited.js";
import { RaisedExcitedNatural as RaisedExcitedNaturalPart } from "./RaisedExcitedNatural.js";
import { SadConcerned as SadConcernedPart } from "./SadConcerned.js";
import { SadConcernedNatural as SadConcernedNaturalPart } from "./SadConcernedNatural.js";
import { UnibrowNatural as UnibrowNaturalPart } from "./UnibrowNatural.js";
import { UpDown as UpDownPart } from "./UpDown.js";
import { UpDownNatural as UpDownNaturalPart } from "./UpDownNatural.js";

/** Avataaars eyebrows parts by option value. */
export const EYEBROWS: Readonly<Record<AvatarEyebrowType, PartComponent>> = {
    Angry: AngryPart,
    AngryNatural: AngryNaturalPart,
    Default: DefaultPart,
    DefaultNatural: DefaultNaturalPart,
    FlatNatural: FlatNaturalPart,
    FrownNatural: FrownNaturalPart,
    RaisedExcited: RaisedExcitedPart,
    RaisedExcitedNatural: RaisedExcitedNaturalPart,
    SadConcerned: SadConcernedPart,
    SadConcernedNatural: SadConcernedNaturalPart,
    UnibrowNatural: UnibrowNaturalPart,
    UpDown: UpDownPart,
    UpDownNatural: UpDownNaturalPart,
};
