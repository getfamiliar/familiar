/**
 * The assistant's avatar (`core.assistantAvatar` in `config.yml`): an
 * Avataaars face described by one value per option. Plain data and
 * validation only — rendering lives in `@getfamiliar/avatar`.
 *
 * Kept free of node imports: browser bundles import it through the
 * `@getfamiliar/shared/avatar` subpath.
 */

/** Config key of the assistant's avatar. */
export const ASSISTANT_AVATAR_CONFIG_KEY = "core.assistantAvatar";

/** Colors of fabric (clothes and hats). */
const FABRIC_COLORS = [
    "Black",
    "Blue01",
    "Blue02",
    "Blue03",
    "Gray01",
    "Gray02",
    "Heather",
    "PastelBlue",
    "PastelGreen",
    "PastelOrange",
    "PastelRed",
    "PastelYellow",
    "Pink",
    "Red",
    "White",
] as const;

/** Allowed values per avatar option (the Avataaars option values). */
export const AVATAR_OPTION_VALUES = {
    topType: [
        "NoHair",
        "Eyepatch",
        "Hat",
        "Hijab",
        "Turban",
        "WinterHat1",
        "WinterHat2",
        "WinterHat3",
        "WinterHat4",
        "LongHairBigHair",
        "LongHairBob",
        "LongHairBun",
        "LongHairCurly",
        "LongHairCurvy",
        "LongHairDreads",
        "LongHairFrida",
        "LongHairFro",
        "LongHairFroBand",
        "LongHairNotTooLong",
        "LongHairShavedSides",
        "LongHairMiaWallace",
        "LongHairStraight",
        "LongHairStraight2",
        "LongHairStraightStrand",
        "ShortHairDreads01",
        "ShortHairDreads02",
        "ShortHairFrizzle",
        "ShortHairShaggyMullet",
        "ShortHairShortCurly",
        "ShortHairShortFlat",
        "ShortHairShortRound",
        "ShortHairShortWaved",
        "ShortHairSides",
        "ShortHairTheCaesar",
        "ShortHairTheCaesarSidePart",
    ],
    accessoriesType: [
        "Blank",
        "Kurt",
        "Prescription01",
        "Prescription02",
        "Round",
        "Sunglasses",
        "Wayfarers",
    ],
    hairColor: [
        "Auburn",
        "Black",
        "Blonde",
        "BlondeGolden",
        "Brown",
        "BrownDark",
        "PastelPink",
        "Blue",
        "Platinum",
        "Red",
        "SilverGray",
    ],
    hatColor: FABRIC_COLORS,
    facialHairType: [
        "Blank",
        "BeardLight",
        "BeardMajestic",
        "BeardMedium",
        "MoustacheFancy",
        "MoustacheMagnum",
    ],
    facialHairColor: [
        "Auburn",
        "Black",
        "Blonde",
        "BlondeGolden",
        "Brown",
        "BrownDark",
        "Platinum",
        "Red",
        "SilverGray",
    ],
    clotheType: [
        "BlazerShirt",
        "BlazerSweater",
        "CollarSweater",
        "GraphicShirt",
        "Hoodie",
        "Overall",
        "ShirtCrewNeck",
        "ShirtScoopNeck",
        "ShirtVNeck",
    ],
    clotheColor: FABRIC_COLORS,
    graphicType: [
        "Bat",
        "Bear",
        "Cumbia",
        "Deer",
        "Diamond",
        "Hola",
        "Pizza",
        "Resist",
        "Selena",
        "Skull",
        "SkullOutline",
    ],
    eyeType: [
        "Close",
        "Cry",
        "Default",
        "Dizzy",
        "EyeRoll",
        "Happy",
        "Hearts",
        "Side",
        "Squint",
        "Surprised",
        "Wink",
        "WinkWacky",
    ],
    eyebrowType: [
        "Angry",
        "AngryNatural",
        "Default",
        "DefaultNatural",
        "FlatNatural",
        "FrownNatural",
        "RaisedExcited",
        "RaisedExcitedNatural",
        "SadConcerned",
        "SadConcernedNatural",
        "UnibrowNatural",
        "UpDown",
        "UpDownNatural",
    ],
    mouthType: [
        "Concerned",
        "Default",
        "Disbelief",
        "Eating",
        "Grimace",
        "Sad",
        "ScreamOpen",
        "Serious",
        "Smile",
        "Tongue",
        "Twinkle",
        "Vomit",
    ],
    skinColor: ["Tanned", "Yellow", "Pale", "Light", "Brown", "DarkBrown", "Black"],
} as const;

/** An avatar option with a fixed set of values. */
export type AvatarOptionField = keyof typeof AVATAR_OPTION_VALUES;

/** A complete avatar: one value per option plus the background color. */
export type AvatarConfig = {
    readonly [Field in AvatarOptionField]: (typeof AVATAR_OPTION_VALUES)[Field][number];
} & {
    /** Background color as `#rrggbb`. */
    readonly backgroundColor: string;
};

/** Value of the `topType` option (hair, hats). */
export type AvatarTopType = AvatarConfig["topType"];
/** Value of the `eyeType` option. */
export type AvatarEyeType = AvatarConfig["eyeType"];
/** Value of the `eyebrowType` option. */
export type AvatarEyebrowType = AvatarConfig["eyebrowType"];
/** Value of the `mouthType` option. */
export type AvatarMouthType = AvatarConfig["mouthType"];

/** The avatar used while `core.assistantAvatar` is unset. */
export const DEFAULT_AVATAR: AvatarConfig = {
    topType: "ShortHairShortFlat",
    accessoriesType: "Blank",
    hairColor: "BrownDark",
    hatColor: "Blue01",
    facialHairType: "Blank",
    facialHairColor: "BrownDark",
    clotheType: "CollarSweater",
    clotheColor: "Blue03",
    graphicType: "Bat",
    eyeType: "Default",
    eyebrowType: "DefaultNatural",
    mouthType: "Smile",
    skinColor: "Light",
    backgroundColor: "#65c9ff",
};

/** Tops drawn with the hair color. */
const TOPS_WITH_HAIR_COLOR: ReadonlySet<AvatarTopType> = new Set([
    "LongHairBigHair",
    "LongHairBob",
    "LongHairBun",
    "LongHairCurly",
    "LongHairCurvy",
    "LongHairDreads",
    "LongHairFro",
    "LongHairFroBand",
    "LongHairNotTooLong",
    "LongHairMiaWallace",
    "LongHairStraight",
    "LongHairStraight2",
    "LongHairStraightStrand",
    "ShortHairDreads01",
    "ShortHairDreads02",
    "ShortHairFrizzle",
    "ShortHairShaggyMullet",
    "ShortHairShortCurly",
    "ShortHairShortFlat",
    "ShortHairShortRound",
    "ShortHairShortWaved",
    "ShortHairSides",
    "ShortHairTheCaesar",
    "ShortHairTheCaesarSidePart",
]);

/** Tops drawn with the hat color. */
const TOPS_WITH_HAT_COLOR: ReadonlySet<AvatarTopType> = new Set([
    "Hijab",
    "Turban",
    "WinterHat1",
    "WinterHat2",
    "WinterHat3",
    "WinterHat4",
]);

/** Clothes drawn with the fabric color. */
const CLOTHES_WITH_COLOR: ReadonlySet<AvatarConfig["clotheType"]> = new Set([
    "CollarSweater",
    "GraphicShirt",
    "Hoodie",
    "Overall",
    "ShirtCrewNeck",
    "ShirtScoopNeck",
    "ShirtVNeck",
]);

/** `#rrggbb`. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * Whether an option has a visible effect for the rest of the avatar,
 * e.g. the hat color only matters for a hat. Editors hide the others.
 *
 * @param field The option.
 * @param config The avatar.
 * @returns `true` when changing the option changes the picture.
 */
export function isAvatarOptionRelevant(field: AvatarOptionField, config: AvatarConfig): boolean {
    switch (field) {
        case "hairColor":
            return TOPS_WITH_HAIR_COLOR.has(config.topType);
        case "hatColor":
            return TOPS_WITH_HAT_COLOR.has(config.topType);
        case "facialHairColor":
            return config.facialHairType !== "Blank";
        case "clotheColor":
            return CLOTHES_WITH_COLOR.has(config.clotheType);
        case "graphicType":
            return config.clotheType === "GraphicShirt";
        default:
            return true;
    }
}

/**
 * Whether `value` is an allowed value of `field`.
 *
 * @param field The option.
 * @param value Candidate value.
 * @returns `true` for an allowed value.
 */
function isAllowedValue(field: AvatarOptionField, value: unknown): boolean {
    return (AVATAR_OPTION_VALUES[field] as readonly unknown[]).includes(value);
}

/**
 * List what is wrong with a stored avatar: not a mapping, unknown
 * options, values outside the allowed set, a malformed background color.
 * Missing options are fine (they fall back to {@link DEFAULT_AVATAR}).
 *
 * @param value Raw value of `core.assistantAvatar`.
 * @returns Human-readable problems, empty when the value is usable as is.
 */
export function findAvatarConfigProblems(value: unknown): string[] {
    if (value === undefined || value === null) {
        return [];
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        return ["must be a mapping of avatar options"];
    }
    const problems: string[] = [];
    for (const [key, entry] of Object.entries(value)) {
        if (key === "backgroundColor") {
            if (typeof entry !== "string" || !HEX_COLOR_PATTERN.test(entry)) {
                problems.push(`backgroundColor must be a #rrggbb color (got ${String(entry)})`);
            }
            continue;
        }
        if (!(key in AVATAR_OPTION_VALUES)) {
            problems.push(`unknown option ${key}`);
            continue;
        }
        const field = key as AvatarOptionField;
        if (!isAllowedValue(field, entry)) {
            problems.push(
                `${key} must be one of ${AVATAR_OPTION_VALUES[field].join(", ")} (got ${String(entry)})`,
            );
        }
    }
    return problems;
}

/**
 * Turn a stored avatar into a complete one: every missing or invalid
 * option takes its {@link DEFAULT_AVATAR} value. Never throws, so a
 * hand-edited config cannot break rendering.
 *
 * @param value Raw value of `core.assistantAvatar`.
 * @returns A complete avatar.
 */
export function normalizeAvatarConfig(value: unknown): AvatarConfig {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return DEFAULT_AVATAR;
    }
    const raw = value as Record<string, unknown>;
    const result: Record<string, unknown> = { ...DEFAULT_AVATAR };
    for (const field of Object.keys(AVATAR_OPTION_VALUES) as AvatarOptionField[]) {
        if (isAllowedValue(field, raw[field])) {
            result[field] = raw[field];
        }
    }
    const background = raw.backgroundColor;
    if (typeof background === "string" && HEX_COLOR_PATTERN.test(background)) {
        result.backgroundColor = background.toLowerCase();
    }
    return result as AvatarConfig;
}
