import {
    Avatar,
    AvatarSvg,
    FABRIC_COLORS,
    FACIAL_HAIR_COLORS,
    HAIR_COLORS,
    SKIN_COLORS,
} from "@getfamiliar/avatar";
import {
    AVATAR_OPTION_VALUES,
    type AvatarConfig,
    type AvatarOptionField,
    isAvatarOptionRelevant,
} from "@getfamiliar/shared/avatar";
import { CheckIcon, RotateCcwIcon, SaveIcon, ShuffleIcon } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Route of this page (contributed to the menu by the web-ui plugin's host side). */
export const AVATAR_SETTINGS_ROUTE = "/settings/avatar";

/** Part of the drawing a thumbnail shows. */
type Crop = "face" | "head" | "body";

/** View boxes of the thumbnail crops (square sections of the 264×280 drawing). */
const CROP_VIEW_BOXES: Readonly<Record<Crop, string>> = {
    face: "74 70 116 116",
    head: "22 0 220 220",
    body: "42 100 180 180",
};

/** One option in the editor: picked from thumbnails or color swatches. */
type FieldSpec =
    | {
          readonly field: AvatarOptionField;
          readonly label: string;
          readonly kind: "parts";
          readonly crop: Crop;
      }
    | {
          readonly field: AvatarOptionField;
          readonly label: string;
          readonly kind: "colors";
          readonly palette: Readonly<Record<string, string>>;
      };

/** A card of related options. */
interface SectionSpec {
    readonly title: string;
    readonly description: string;
    readonly fields: readonly FieldSpec[];
}

/** The editor's cards, in display order. */
const SECTIONS: readonly SectionSpec[] = [
    {
        title: "Face",
        description:
            "The resting expression. Plugins may change it for a moment, e.g. while talking.",
        fields: [
            { field: "eyeType", label: "Eyes", kind: "parts", crop: "face" },
            { field: "eyebrowType", label: "Eyebrows", kind: "parts", crop: "face" },
            { field: "mouthType", label: "Mouth", kind: "parts", crop: "face" },
        ],
    },
    {
        title: "Hair & headwear",
        description: "Hairstyle or hat, and its color.",
        fields: [
            { field: "topType", label: "Style", kind: "parts", crop: "head" },
            { field: "hairColor", label: "Hair color", kind: "colors", palette: HAIR_COLORS },
            { field: "hatColor", label: "Hat color", kind: "colors", palette: FABRIC_COLORS },
        ],
    },
    {
        title: "Skin",
        description: "Skin tone of face and neck.",
        fields: [{ field: "skinColor", label: "Skin tone", kind: "colors", palette: SKIN_COLORS }],
    },
    {
        title: "Facial hair",
        description: "Beard or moustache.",
        fields: [
            { field: "facialHairType", label: "Style", kind: "parts", crop: "face" },
            {
                field: "facialHairColor",
                label: "Color",
                kind: "colors",
                palette: FACIAL_HAIR_COLORS,
            },
        ],
    },
    {
        title: "Accessories",
        description: "Glasses and sunglasses.",
        fields: [{ field: "accessoriesType", label: "Glasses", kind: "parts", crop: "face" }],
    },
    {
        title: "Clothes",
        description: "What the assistant wears.",
        fields: [
            { field: "clotheType", label: "Clothing", kind: "parts", crop: "body" },
            { field: "clotheColor", label: "Fabric", kind: "colors", palette: FABRIC_COLORS },
            { field: "graphicType", label: "Print", kind: "parts", crop: "body" },
        ],
    },
];

/** Background colors offered next to the color picker. */
const BACKGROUND_PRESETS: readonly string[] = [
    "#65c9ff",
    "#b1e2ff",
    "#a7ffc4",
    "#ffdeb5",
    "#ffafb9",
    "#ffffb1",
    "#e6e6e6",
    "#929598",
    "#3c4f5c",
    "#262e33",
];

/** Face parts used when randomizing (leaving out the comic extremes). */
const PLEASANT_FACE: Readonly<Partial<Record<AvatarOptionField, readonly string[]>>> = {
    eyeType: ["Default", "Happy", "Side", "Squint", "Surprised", "Wink"],
    eyebrowType: [
        "Default",
        "DefaultNatural",
        "FlatNatural",
        "RaisedExcited",
        "RaisedExcitedNatural",
        "UpDown",
        "UpDownNatural",
    ],
    mouthType: ["Default", "Smile", "Twinkle", "Serious", "Tongue"],
};

/** Outcome of the last save, shown under the buttons. */
type SaveState =
    | { readonly kind: "idle" }
    | { readonly kind: "saving" }
    | { readonly kind: "saved" }
    | { readonly kind: "failed"; readonly message: string };

/**
 * Human label of an option value: `LongHairStraight2` → `Long hair
 * straight 2`, `Blank` → `None`.
 *
 * @param value Option value.
 * @returns The label.
 */
function labelOf(value: string): string {
    if (value === "Blank") {
        return "None";
    }
    const words = value
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Za-z])(\d)/g, "$1 $2")
        .toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Pick a random element.
 *
 * @param values Candidates (non-empty).
 * @returns One of them.
 */
function pickRandom<T>(values: readonly T[]): T {
    return values[Math.floor(Math.random() * values.length)] as T;
}

/**
 * A random avatar that keeps the background: pleasant faces, glasses and
 * facial hair only now and then.
 *
 * @param current The avatar being edited.
 * @returns A new avatar.
 */
function randomAvatar(current: AvatarConfig): AvatarConfig {
    const next: Record<string, string> = { backgroundColor: current.backgroundColor };
    for (const field of Object.keys(AVATAR_OPTION_VALUES) as AvatarOptionField[]) {
        next[field] = pickRandom(PLEASANT_FACE[field] ?? AVATAR_OPTION_VALUES[field]);
    }
    if (Math.random() < 0.7) {
        next.accessoriesType = "Blank";
    }
    if (Math.random() < 0.7) {
        next.facialHairType = "Blank";
    }
    return next as AvatarConfig;
}

/**
 * The avatar a thumbnail shows for `value`: the edited avatar with that
 * value, and for face close-ups without hair and other parts that would
 * cover what is being picked.
 *
 * @param draft The avatar being edited.
 * @param spec The option.
 * @param value The value to preview.
 * @returns The thumbnail's avatar.
 */
function thumbnailConfig(draft: AvatarConfig, spec: FieldSpec, value: string): AvatarConfig {
    const withValue = { ...draft, [spec.field]: value } as AvatarConfig;
    if (spec.kind !== "parts" || spec.crop !== "face") {
        return withValue;
    }
    return {
        ...withValue,
        topType: "NoHair",
        accessoriesType: spec.field === "accessoriesType" ? withValue.accessoriesType : "Blank",
        facialHairType: spec.field === "facialHairType" ? withValue.facialHairType : "Blank",
    };
}

/**
 * Store the avatar through the web UI's API.
 *
 * @param avatar The avatar.
 * @returns The stored avatar.
 * @throws {Error} With the server's message when it refuses.
 */
async function saveAvatar(avatar: AvatarConfig): Promise<AvatarConfig> {
    const response = await fetch("/api/settings/avatar", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(avatar),
    });
    const body = (await response.json().catch(() => ({}))) as {
        avatar?: AvatarConfig;
        error?: string;
    };
    if (!response.ok || body.avatar === undefined) {
        throw new Error(body.error ?? `the server answered ${response.status}`);
    }
    return body.avatar;
}

/**
 * Settings → Avatar: edit the assistant's avatar with a live, animated
 * preview. Options are grouped in cards (as many columns as fit), each
 * value shown as a thumbnail of the avatar wearing it; options without
 * effect (hat color without a hat …) are hidden. Saving writes
 * `core.assistantAvatar` and updates brand, favicon and plugin pages.
 *
 * @param props.savedAvatar The stored avatar.
 * @param props.onSaved Called with the avatar after a successful save.
 * @returns The page.
 */
export function AvatarSettings({
    savedAvatar,
    onSaved,
}: {
    readonly savedAvatar: AvatarConfig;
    readonly onSaved: (avatar: AvatarConfig) => void;
}) {
    const [draft, setDraft] = useState<AvatarConfig>(savedAvatar);
    const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
    const isDirty = JSON.stringify(draft) !== JSON.stringify(savedAvatar);

    useEffect(() => {
        if (!isDirty) {
            return;
        }
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [isDirty]);

    // Changes apply to the latest draft (functional update): memoized
    // thumbnails keep their click handler across renders, so a handler
    // must never carry a draft of its own.
    const change = useCallback((update: Partial<AvatarConfig>) => {
        setDraft((current) => ({ ...current, ...update }));
        setSaveState({ kind: "idle" });
    }, []);
    const save = async () => {
        setSaveState({ kind: "saving" });
        try {
            const stored = await saveAvatar(draft);
            setDraft(stored);
            onSaved(stored);
            setSaveState({ kind: "saved" });
        } catch (err) {
            setSaveState({
                kind: "failed",
                message: err instanceof Error ? err.message : String(err),
            });
        }
    };

    return (
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0 lg:flex-row lg:items-start">
            <Card className="shrink-0 lg:sticky lg:top-4 lg:w-72 xl:w-80">
                <CardContent className="flex flex-col items-center gap-4">
                    <Avatar
                        config={draft}
                        title="Avatar preview"
                        className="aspect-[264/280] w-full max-w-64 rounded-2xl shadow-sm"
                    />
                    <div className="flex flex-wrap justify-center gap-2">
                        <Button variant="outline" onClick={() => change(randomAvatar(draft))}>
                            <ShuffleIcon />
                            Randomize
                        </Button>
                        <Button
                            variant="outline"
                            disabled={!isDirty}
                            onClick={() => change(savedAvatar)}
                        >
                            <RotateCcwIcon />
                            Reset
                        </Button>
                        <Button disabled={!isDirty || saveState.kind === "saving"} onClick={save}>
                            <SaveIcon />
                            Save
                        </Button>
                    </div>
                    <SaveStatus state={saveState} isDirty={isDirty} />
                </CardContent>
            </Card>
            <div className="grid min-w-0 flex-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
                {SECTIONS.map((section) => (
                    <SectionCard
                        key={section.title}
                        section={section}
                        draft={draft}
                        onChange={change}
                    />
                ))}
                <BackgroundCard draft={draft} onChange={change} />
            </div>
        </div>
    );
}

/**
 * Line under the buttons: unsaved changes, saving, saved or the error.
 *
 * @param props.state Save outcome.
 * @param props.isDirty Whether the draft differs from the stored avatar.
 * @returns The line.
 */
function SaveStatus({ state, isDirty }: { readonly state: SaveState; readonly isDirty: boolean }) {
    if (state.kind === "failed") {
        return <p className="text-center text-destructive text-sm">{state.message}</p>;
    }
    if (state.kind === "saving") {
        return <p className="text-muted-foreground text-sm">Saving…</p>;
    }
    if (state.kind === "saved" && !isDirty) {
        return (
            <p className="flex items-center gap-1 text-muted-foreground text-sm">
                <CheckIcon className="size-4" />
                Saved
            </p>
        );
    }
    return (
        <p className="text-muted-foreground text-sm">
            {isDirty ? "Unsaved changes" : "Pick options to change the avatar."}
        </p>
    );
}

/**
 * A card with the relevant options of one group.
 *
 * @param props.section The group.
 * @param props.draft The avatar being edited.
 * @param props.onChange Receives the changed options.
 * @returns The card.
 */
function SectionCard({
    section,
    draft,
    onChange,
}: {
    readonly section: SectionSpec;
    readonly draft: AvatarConfig;
    readonly onChange: (update: Partial<AvatarConfig>) => void;
}) {
    const fields = section.fields.filter((spec) => isAvatarOptionRelevant(spec.field, draft));
    return (
        <Card>
            <CardHeader>
                <CardTitle>{section.title}</CardTitle>
                <CardDescription>{section.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
                {fields.map((spec) => (
                    <div key={spec.field} className="flex flex-col gap-2">
                        <div className="flex items-baseline justify-between gap-2 text-sm">
                            <span className="font-medium">{spec.label}</span>
                            <span className="truncate text-muted-foreground text-xs">
                                {labelOf(draft[spec.field])}
                            </span>
                        </div>
                        {spec.kind === "parts" ? (
                            <PartPicker spec={spec} draft={draft} onChange={onChange} />
                        ) : (
                            <SwatchPicker
                                values={AVATAR_OPTION_VALUES[spec.field]}
                                colorOf={(value) => spec.palette[value] ?? "#000000"}
                                selected={draft[spec.field]}
                                onSelect={(value) => onChange({ [spec.field]: value })}
                            />
                        )}
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}

/**
 * Thumbnails of the avatar with each value of an option.
 *
 * @param props.spec The option (kind `parts`).
 * @param props.draft The avatar being edited.
 * @param props.onChange Receives the changed options.
 * @returns The grid.
 */
function PartPicker({
    spec,
    draft,
    onChange,
}: {
    readonly spec: Extract<FieldSpec, { kind: "parts" }>;
    readonly draft: AvatarConfig;
    readonly onChange: (update: Partial<AvatarConfig>) => void;
}) {
    return (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(3.75rem,1fr))] gap-2">
            {AVATAR_OPTION_VALUES[spec.field].map((value) => (
                <PartTile
                    key={value}
                    config={thumbnailConfig(draft, spec, value)}
                    viewBox={CROP_VIEW_BOXES[spec.crop]}
                    label={labelOf(value)}
                    isSelected={draft[spec.field] === value}
                    onSelect={() => onChange({ [spec.field]: value })}
                />
            ))}
        </div>
    );
}

/** Props of {@link PartTile}. */
interface PartTileProps {
    readonly config: AvatarConfig;
    readonly viewBox: string;
    readonly label: string;
    readonly isSelected: boolean;
    readonly onSelect: () => void;
}

/**
 * One thumbnail button; re-renders only when its picture or state
 * changes (a page has more than a hundred of them).
 */
const PartTile = memo(
    function PartTile({ config, viewBox, label, isSelected, onSelect }: PartTileProps) {
        return (
            <button
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={isSelected}
                onClick={onSelect}
                className={cn(
                    "overflow-hidden rounded-lg ring-offset-2 ring-offset-card transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isSelected ? "ring-2 ring-primary" : "hover:ring-2 hover:ring-border",
                )}
            >
                <AvatarSvg
                    config={config}
                    viewBox={viewBox}
                    className="block aspect-square w-full"
                />
            </button>
        );
    },
    (before, after) =>
        before.viewBox === after.viewBox &&
        before.label === after.label &&
        before.isSelected === after.isSelected &&
        JSON.stringify(before.config) === JSON.stringify(after.config),
);

/**
 * Round color buttons.
 *
 * @param props.values Option values.
 * @param props.colorOf Color of a value.
 * @param props.selected Selected value.
 * @param props.onSelect Receives the clicked value.
 * @returns The swatches.
 */
function SwatchPicker({
    values,
    colorOf,
    selected,
    onSelect,
}: {
    readonly values: readonly string[];
    readonly colorOf: (value: string) => string;
    readonly selected: string;
    readonly onSelect: (value: string) => void;
}) {
    return (
        <div className="flex flex-wrap gap-2">
            {values.map((value) => (
                <button
                    key={value}
                    type="button"
                    title={value.startsWith("#") ? value : labelOf(value)}
                    aria-label={value.startsWith("#") ? value : labelOf(value)}
                    aria-pressed={value === selected}
                    onClick={() => onSelect(value)}
                    style={{ backgroundColor: colorOf(value) }}
                    className={cn(
                        "size-8 rounded-full border border-black/10 ring-offset-2 ring-offset-card transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        value === selected
                            ? "ring-2 ring-primary"
                            : "hover:ring-2 hover:ring-border",
                    )}
                />
            ))}
        </div>
    );
}

/**
 * The background color: a color picker plus a few presets.
 *
 * @param props.draft The avatar being edited.
 * @param props.onChange Receives the changed options.
 * @returns The card.
 */
function BackgroundCard({
    draft,
    onChange,
}: {
    readonly draft: AvatarConfig;
    readonly onChange: (update: Partial<AvatarConfig>) => void;
}) {
    const setBackground = (color: string) => onChange({ backgroundColor: color.toLowerCase() });
    return (
        <Card>
            <CardHeader>
                <CardTitle>Background</CardTitle>
                <CardDescription>Shown behind the avatar, also in the favicon.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <label className="flex items-center gap-3 text-sm">
                    <input
                        type="color"
                        value={draft.backgroundColor}
                        onChange={(event) => setBackground(event.target.value)}
                        className="size-10 cursor-pointer rounded-md border bg-transparent p-0.5"
                    />
                    <span className="font-mono text-muted-foreground">{draft.backgroundColor}</span>
                </label>
                <SwatchPicker
                    values={BACKGROUND_PRESETS}
                    colorOf={(value) => value}
                    selected={draft.backgroundColor}
                    onSelect={setBackground}
                />
            </CardContent>
        </Card>
    );
}
