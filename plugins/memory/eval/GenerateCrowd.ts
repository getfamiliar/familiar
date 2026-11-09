/**
 * Deterministic generator for the "crowd" of the memory eval corpus: 200 additional people and
 * 100 additional threads per language that make the corpus realistically crowded.
 *
 * The hand-written persona files have one file per name; with only ~70 files, a misspelled name
 * still lands near the right file by vector similarity alone. The crowd adds the wider circle of
 * the persona (clients' staff, school and handball parents, neighbours, craftspeople, therapists,
 * founders, developers, former colleagues, association members) plus threads about *other*
 * contexts, with deliberately confusable first names (clusters of Tobias, Mara/Maria/Marah, …)
 * and surnames 1–3 edits away from persona surnames (Hartmann, Lindquist, Ostermeier, …).
 *
 * Hard rules, enforced before anything is written (the script throws on a violation):
 * - no persona surname, persona first name, persona proper noun or negative-case term appears
 *   in any generated text (see {@link FORBIDDEN_TERMS});
 * - no date that appears in `cases.yml` or `persona.md` is used, and no month-day of a date
 *   used in a case query in any year;
 * - no generated file collides with a hand-written file. `corpus/<lang>/.crowd-manifest.json`
 *   lists the generated files; a rerun deletes exactly those first and refuses to overwrite
 *   anything else.
 *
 * Run from the repo root (output is deterministic):
 *
 * ```
 * npx tsx plugins/memory/eval/GenerateCrowd.ts
 * ```
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Corpus languages. */
const LANGUAGES = ["de", "en"] as const;

/** A corpus language. */
type Language = (typeof LANGUAGES)[number];

/** A text in both corpus languages. */
interface Bilingual {
    readonly de: string;
    readonly en: string;
}

/** Seeded pseudo-random source. */
interface Random {
    /** Uniform float in [0, 1). */
    next(): number;
    /** Uniform integer in [min, max] (inclusive). */
    int(min: number, max: number): number;
    /** One element of a non-empty list. */
    pick<T>(items: readonly T[]): T;
    /** True with probability `p`. */
    chance(p: number): boolean;
    /** A shuffled copy of a list. */
    shuffle<T>(items: readonly T[]): T[];
}

/** Grammatical gender of a person, for German role nouns. */
type Gender = "f" | "m";

/** The kinds of people in the crowd. */
type Role =
    | "client"
    | "schoolParent"
    | "handballParent"
    | "neighbour"
    | "craftsperson"
    | "therapist"
    | "founder"
    | "developer"
    | "formerColleague"
    | "association";

/** One generated person. */
interface Person {
    readonly first: string;
    readonly last: string;
    readonly gender: Gender;
    readonly slug: string;
    readonly role: Role;
    readonly town: string;
    /** Company, club, association, practice, … depending on the role. */
    readonly organisation: Organisation;
    /** Threads that link to this person, filled while generating threads. */
    readonly threads: { readonly slug: Bilingual; readonly title: Bilingual }[];
}

/** An organisation a person belongs to. */
interface Organisation {
    readonly name: Bilingual;
    readonly domain: string;
}

/** One generated markdown file in both languages. */
interface GeneratedFile {
    /** Workspace-relative path per language. */
    readonly path: Bilingual;
    /** File content per language. */
    readonly content: Bilingual;
}

/** PRNG seed — change only deliberately, the corpus is committed. */
const SEED = 0x5eed_c0de;

/** Number of generated people. */
const PEOPLE_COUNT = 200;

/** Earliest and latest generated date. */
const DATE_RANGE = { from: "2024-01-01", to: "2026-10-31" } as const;

/**
 * Terms that must never appear in generated text, matched on letter/digit boundaries —
 * case-insensitively, except all-caps acronyms. A trailing `*` makes the term a prefix (no right
 * boundary).
 */
const FORBIDDEN_TERMS: readonly string[] = [
    // Persona surnames.
    "Weiß",
    "Weiss",
    "Harter",
    "Hartl",
    "Größler",
    "Groessler",
    "Ziegenbalg",
    "Brünnich",
    "Bruennich",
    "Szymanski",
    "Lindqvist",
    "Ostermann",
    "Wendt",
    "Hoffmann",
    "Demir",
    "Tran",
    "Aydin",
    "Pohlmann",
    "Reuter",
    "Nowak",
    "Sommer",
    "Kranz",
    "Pfaff",
    "Brandt",
    "Kramer",
    "Ebeling",
    "Rademacher",
    "Brandl",
    "Gerlach",
    "Jäger",
    "Lenz",
    "Vogt",
    // Persona first names that are distinctive (common ones like Tobias are wanted clusters).
    "Jürgen",
    "Juergen",
    // "Ines" is not listed: the slug and mail address of the wanted look-alike "Inês" spell it
    // "ines"; the persona's Ines is still excluded through her surname.
    "Friederike",
    "Fritzi",
    "Gisela",
    "Hedi",
    "Roswitha",
    "Jannis",
    "Janis",
    "Henrik",
    "Wolfram",
    "Helga",
    "Nele",
    "Yusuf",
    "Selin",
    "Leo",
    "Klaus",
    "Marek",
    "Julia",
    "Ole",
    "Ida",
    "Mia",
    "Anke",
    "Carsten",
    "Uwe",
    // Persona proper nouns.
    "Thermo-Pi",
    "Thermo Pi",
    "Sternenimperium",
    "Star Empire",
    "Brightwater",
    "Lumora",
    "FunkFix",
    "ReTech",
    "Nordbank",
    "pushTAN",
    "Alte Mühle",
    "Alten Mühle",
    "Mühlbach",
    "Muehlbach",
    "Ahornweg",
    "Lindenstraße",
    "Lindenstr",
    "Bahnhofstraße 12",
    "Zum Schwan",
    "Falkenstein",
    "Hyundai",
    "Mazda",
    "Gleitsicht*",
    "varifocal*",
    "Klarblick",
    "KRW",
    "Hanse Direkt",
    "Sonnenhang",
    "PlantWatch",
    "Brotzeit",
    "Unterbrunn",
    "Lauterbrunn",
    "SPS",
    "SPM",
    "Hoflix",
    "Azubio",
    "Bewegungsraum",
    "Baan Siam",
    "Klangwerk",
    "PaketPilot",
    "Papierwelt",
    "Grünzeug",
    "Blitzbote",
    "Ostring",
    "Hellwig",
    "Grenzwelten",
    "Frontier Worlds",
    "Hirtshals",
    "Ålesund",
    "Alesund",
    "Birkenweg 12",
    "Hauptstraße 40",
    "Kirchgasse 5",
    "Am Rathaus 3",
    "Marktplatz 4",
    "Mühlweg",
    "Gründerstammtisch*",
    "founders meetup*",
    "Stammtisch*",
    "meetup*",
    "Side-Project*",
    "Side Project*",
    "Jugendherberge*",
    "youth hostel*",
    "Hackathon*",
    "BW-PO",
    "BW-2026",
    "KB-JW",
    "KB-IW",
    "Heizkostenverteiler*",
    "heating cost allocator*",
    // Negative-case queries.
    "Tom",
    "Studio Nord",
    "Nord",
    "Coworking",
    "Tablet*",
    "E-Ink",
    "Segel*",
    "sailing",
    "Zahnarzt*",
    "dentist*",
    "Bitcoin",
    "Krypto*",
    "crypto*",
    "Hochzeitstag*",
    "wedding anniversary",
    "Investment*",
    "investier*",
    "invest*",
    "Beteiligung*",
    "offene Aufgaben",
    "open tasks",
    // Topics of positive cases a crowd file must not answer by accident.
    "Reha*",
    "rehab*",
    "Knie*",
    "knee*",
    "Erbe",
    "Erbschein*",
    "Erbschaft*",
    "geerbt*",
    "inherit*",
    "Grundbuch*",
    "land registry",
    "Brotback*",
    "bread",
    "Zimmerpflanze*",
    "houseplant*",
    "Brettspiel*",
    "board game*",
    "Ferienhaus*",
    "holiday cabin*",
    "Skandinavien*",
    "Scandinavia*",
    "Norwegen*",
    "Norway*",
    "Allergie*",
    "allerg*",
    "lasern",
    "laser*",
    "Marder*",
    "marten*",
    "Reifen*",
    "tyre*",
    "Winterräder",
    "winter wheels",
    "Smart Repair",
    "Steinschlag*",
    "stone chip*",
    "Phishing*",
    "Geschenkidee*",
    "gift idea*",
    "Kindergeburtstag*",
    "birthday",
    "Hausärzt*",
    "Hausarzt*",
    "GP",
    "family doctor",
    "Steuer*",
    "tax*",
    "accountant*",
    "Notar*",
    "notary*",
    "Berufsunfähig*",
    "disability",
    "Lieblingsblume*",
    "favourite flower*",
    "Lieblingsessen",
    "favourite food",
    "Wochenplan",
    "workout schedule",
    "Augen*",
    "eye*",
    "Linsen",
    "lens*",
    "Brille*",
    "glasses",
    "Optik*",
    "optician*",
    "Eigentümer*",
    "owners' association",
    "owners association",
    "HOA",
    "WEG",
    "Ferienbetreuung*",
    "holiday care",
    "Sommerferien",
    "summer holiday*",
    "Naturcamp",
    "nature camp",
    "Umlage*",
    "levy",
    "Interessent*",
    "Besichtigung*",
    "viewing*",
    "Diensthandy*",
    "work phone*",
    "gehackt",
    "hacked",
    "Smart-Home*",
    "smart home",
    "Cloud-Migration",
    "cloud migration",
    "Datenplattform",
    "data platform",
    "Tierarzt*",
    "vet",
    "Fähre*",
    "ferry",
    "Fußball*",
    "football",
    "Kopfhörer*",
    "headphone*",
    "Druckerpatrone*",
    "ink cartridge*",
    "Gartenschlauch*",
    "garden hose*",
    "Mobilfunk*",
    "Handyvertrag*",
    "mobile contract*",
];

/** Persona dates that are not literally in `cases.yml` but own a fact. */
const KEY_PERSONA_DATES = [
    "2026-05-25",
    "2026-05-14",
    "2026-06-09",
    "2026-10-24",
    "2026-07-15",
    "2026-04-02",
];

/** English month names, for parsing "May 25" / "14 May" in case queries. */
const ENGLISH_MONTHS = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/** German month names, for parsing "25. Mai" in case queries. */
const GERMAN_MONTHS = [
    "januar",
    "februar",
    "märz",
    "april",
    "mai",
    "juni",
    "juli",
    "august",
    "september",
    "oktober",
    "november",
    "dezember",
];

/**
 * Builds a mulberry32 PRNG — tiny, fast and stable across Node versions.
 *
 * @param seed - 32-bit integer seed.
 * @returns A {@link Random} drawing from the seeded sequence.
 */
function createRandom(seed: number): Random {
    let state = seed >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
    return {
        next,
        int,
        pick: (items) => items[Math.floor(next() * items.length)],
        chance: (p) => next() < p,
        shuffle: (items) => {
            const copy = [...items];
            for (let i = copy.length - 1; i > 0; i--) {
                const j = int(0, i);
                [copy[i], copy[j]] = [copy[j], copy[i]];
            }
            return copy;
        },
    };
}

/**
 * Shorthand for a bilingual text.
 *
 * @param de - German text.
 * @param en - English text; defaults to the German one (names, numbers).
 * @returns The bilingual text.
 */
function bi(de: string, en: string = de): Bilingual {
    return { de, en };
}

/**
 * Turns a display name into a slug: lower case, umlauts transliterated, other diacritics
 * dropped, anything else non-alphanumeric collapsed to `-`.
 *
 * @param text - Display text.
 * @returns The kebab-case slug.
 */
function slugify(text: string): string {
    return text
        .toLowerCase()
        .replaceAll("ä", "ae")
        .replaceAll("ö", "oe")
        .replaceAll("ü", "ue")
        .replaceAll("ß", "ss")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

/**
 * Escapes a string for use inside a regular expression.
 *
 * @param text - Literal text.
 * @returns The escaped text.
 */
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles {@link FORBIDDEN_TERMS} into one matcher per term.
 *
 * @returns Term and regular expression pairs.
 */
function compileForbiddenTerms(): { readonly term: string; readonly pattern: RegExp }[] {
    return FORBIDDEN_TERMS.map((term) => {
        const isPrefix = term.endsWith("*");
        const stem = escapeRegExp(isPrefix ? term.slice(0, -1) : term);
        const right = isPrefix ? "" : "(?![\\p{L}\\p{N}])";
        // All-caps acronyms (WEG, GP, SPS, …) match case-sensitively, so "Weg" stays usable.
        const flags = /^[A-Z]{2,}$/.test(term) ? "u" : "iu";
        return { term, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${stem}${right}`, flags) };
    });
}

/**
 * Collects every date the crowd must not use: all ISO and `dd.mm.yyyy` dates in `cases.yml`
 * and `persona.md`, the key persona dates, and — for dates written in case queries — the same
 * month-day in every year of the date range.
 *
 * @param evalDir - Absolute path of the eval folder.
 * @returns A predicate telling whether an ISO date is forbidden.
 * @throws {Error} When `cases.yml` or `persona.md` cannot be read.
 */
function buildForbiddenDatePredicate(evalDir: string): (iso: string) => boolean {
    const cases = fs.readFileSync(path.join(evalDir, "cases.yml"), "utf8");
    const persona = fs.readFileSync(path.join(evalDir, "persona.md"), "utf8");
    const exact = new Set<string>(KEY_PERSONA_DATES);
    for (const text of [cases, persona]) {
        for (const match of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
            exact.add(match[0]);
        }
        for (const match of text.matchAll(/\b(\d{2})\.(\d{2})\.(\d{4})\b/g)) {
            exact.add(`${match[3]}-${match[2]}-${match[1]}`);
        }
    }

    const monthDays = new Set<string>();
    const queryLines = cases.split("\n").filter((line) => /^\s*query:|^\s{4,}(de|en):/.test(line));
    const queryText = queryLines.join("\n").toLowerCase();
    for (const match of queryText.matchAll(/-(\d{2})-(\d{2})\b/g)) {
        monthDays.add(`${match[1]}-${match[2]}`);
    }
    for (const match of queryText.matchAll(/\b(\d{2})\.(\d{2})\.\d{4}\b/g)) {
        monthDays.add(`${match[2]}-${match[1]}`);
    }
    const twoDigits = (value: number): string => String(value).padStart(2, "0");
    GERMAN_MONTHS.forEach((month, index) => {
        for (const match of queryText.matchAll(new RegExp(`(\\d{1,2})\\.\\s*${month}\\b`, "gu"))) {
            monthDays.add(`${twoDigits(index + 1)}-${twoDigits(Number(match[1]))}`);
        }
    });
    ENGLISH_MONTHS.forEach((month, index) => {
        const patterns = [
            new RegExp(`\\b${month}\\s+(\\d{1,2})\\b`, "g"),
            new RegExp(`\\b(\\d{1,2})\\s+${month}\\b`, "g"),
        ];
        for (const pattern of patterns) {
            for (const match of queryText.matchAll(pattern)) {
                monthDays.add(`${twoDigits(index + 1)}-${twoDigits(Number(match[1]))}`);
            }
        }
    });
    return (iso) => exact.has(iso) || monthDays.has(iso.slice(5));
}

/**
 * Creates a date source that draws random allowed ISO dates within {@link DATE_RANGE}.
 *
 * @param random - PRNG.
 * @param isForbidden - Predicate for forbidden dates.
 * @returns A function returning `count` sorted, distinct allowed dates.
 */
function createDateSource(
    random: Random,
    isForbidden: (iso: string) => boolean,
): (count: number) => string[] {
    const start = Date.parse(`${DATE_RANGE.from}T00:00:00Z`);
    const days = Math.floor((Date.parse(`${DATE_RANGE.to}T00:00:00Z`) - start) / 86_400_000);
    return (count) => {
        const dates = new Set<string>();
        while (dates.size < count) {
            const iso = new Date(start + random.int(0, days) * 86_400_000)
                .toISOString()
                .slice(0, 10);
            if (!isForbidden(iso)) {
                dates.add(iso);
            }
        }
        return [...dates].sort();
    };
}

// ---------------------------------------------------------------- name and place pools

/** Female first names (clusters first). */
const FEMALE_FIRST_NAMES = [
    "Mara",
    "Maria",
    "Marah",
    "Katrin",
    "Kathrin",
    "Inês",
    "Inge",
    "Iris",
    "Sophie",
    "Hanna",
    "Clara",
    "Greta",
    "Lena",
    "Nora",
    "Paula",
    "Svenja",
    "Tanja",
    "Petra",
    "Elif",
    "Aylin",
    "Zofia",
    "Agnieszka",
    "Freya",
    "Marlene",
    "Ronja",
    "Judith",
    "Vera",
    "Doris",
    "Ulrike",
    "Beate",
    "Silke",
    "Carla",
    "Ilka",
    "Anna",
    "Lisa",
];

/** Male first names (clusters first). */
const MALE_FIRST_NAMES = [
    "Tobias",
    "Sven",
    "Björn",
    "Paul",
    "Hendrik",
    "Kai",
    "Dirk",
    "Ralf",
    "Lukas",
    "Felix",
    "Frank",
    "Holger",
    "Jens",
    "Lars",
    "Malte",
    "Nils",
    "Timo",
    "Florian",
    "Gregor",
    "Emre",
    "Murat",
    "Piotr",
    "Rafael",
    "Joost",
    "Arne",
    "Gerd",
    "Bernd",
    "Moritz",
    "Wolfgang",
];

/** General surnames that fill the crowd beyond the confusable ones. */
const GENERAL_SURNAMES = [
    "Becker",
    "Krüger",
    "Neumann",
    "Albrecht",
    "Vogel",
    "Engel",
    "Haas",
    "Kühn",
    "Lorenz",
    "Seidel",
    "Franke",
    "Graf",
    "Horn",
    "Busch",
    "Winkler",
    "Kaiser",
    "Arnold",
    "Roth",
    "Beck",
    "Lang",
    "Brenner",
    "Kessler",
    "Böhm",
    "Dietrich",
    "Ernst",
    "Fuchs",
    "Huber",
    "Jansen",
    "Keller",
    "Ludwig",
    "Maurer",
    "Peters",
    "Ritter",
    "Schmitt",
    "Thiel",
    "Vogler",
    "Walter",
    "Wolf",
    "Yilmaz",
    "Kaya",
    "Novak",
    "Petrović",
    "Rossi",
    "Costa",
    "Ferreira",
    "Haddad",
    "Okafor",
    "Hansen",
    "Lehmann",
    "Scholz",
    "Krause",
    "Pohl",
    "Behrens",
    "Kuhlmann",
    "Rieger",
    "Stein",
    "Ebert",
    "Hesse",
];

/** Confusable surnames, 1–3 edits or a shared prefix away from persona surnames. */
const CONFUSABLE_SURNAMES = [
    "Hartmann",
    "Hartwig",
    "Harting",
    "Hartlieb",
    "Harder",
    "Lindquist",
    "Lindholm",
    "Lindberg",
    "Lindner",
    "Lindemann",
    "Osterkamp",
    "Ostermeier",
    "Osterloh",
    "Ostmann",
    "Szymczak",
    "Szymańska",
    "Szymon",
    "Ziegenhagen",
    "Ziegler",
    "Ziegenhorn",
    "Brünning",
    "Brüning",
    "Brünner",
    "Größner",
    "Grössing",
    "Grosser",
    "Wendland",
    "Wendel",
    "Wendtner",
    "Demirci",
    "Pohlmeier",
    "Reutter",
    "Nowacki",
    "Sommerfeld",
    "Kranzler",
    "Pfaffinger",
];

/**
 * People that must exist so the confusable clusters are guaranteed, in addition to random ones:
 * `[first, last, gender]`.
 */
const SEEDED_PEOPLE: readonly (readonly [string, string, Gender])[] = [
    ["Tobias", "Hartmann", "m"],
    ["Tobias", "Hartwig", "m"],
    ["Tobias", "Harting", "m"],
    ["Tobias", "Hartlieb", "m"],
    ["Tobias", "Harder", "m"],
    ["Tobias", "Lindner", "m"],
    ["Mara", "Lindholm", "f"],
    ["Maria", "Lindquist", "f"],
    ["Marah", "Lindberg", "f"],
    ["Mara", "Lindemann", "f"],
    ["Maria", "Osterloh", "f"],
    ["Katrin", "Brünning", "f"],
    ["Kathrin", "Brüning", "f"],
    ["Katrin", "Ziegler", "f"],
    ["Kathrin", "Wendel", "f"],
    ["Sven", "Ostermeier", "m"],
    ["Sven", "Osterkamp", "m"],
    ["Sven", "Ostmann", "m"],
    ["Björn", "Größner", "m"],
    ["Björn", "Grössing", "m"],
    ["Björn", "Grosser", "m"],
    ["Inês", "Szymańska", "f"],
    ["Inge", "Ziegenhagen", "f"],
    ["Iris", "Ziegenhorn", "f"],
    ["Paul", "Wendland", "m"],
    ["Paul", "Wendtner", "m"],
    ["Paul", "Szymczak", "m"],
    ["Anna", "Reutter", "f"],
    ["Hendrik", "Sommerfeld", "m"],
    ["Dirk", "Pohlmeier", "m"],
    ["Emre", "Demirci", "m"],
    ["Piotr", "Nowacki", "m"],
    ["Holger", "Kranzler", "m"],
    ["Beate", "Pfaffinger", "f"],
    ["Agnieszka", "Szymon", "f"],
    ["Ralf", "Brünner", "m"],
    ["Wolfgang", "Ziegler", "m"],
    ["Kai", "Wendland", "m"],
    ["Lisa", "Lindholm", "f"],
    ["Svenja", "Ostermeier", "f"],
];

/** Towns of the crowd (the persona's town plus fictional neighbours). */
const TOWNS = ["Kaltenbach", "Eschenrode", "Hollerbach", "Wiesenfeld", "Oberweiler", "Rotenfels"];

/** Streets for neighbours and renovations (never a persona street). */
const STREETS = [
    "Kastanienweg",
    "Eichendorffstraße",
    "Lerchenweg",
    "Am Hang",
    "Gartenstraße",
    "Schulstraße",
    "Talweg",
    "Mühlbacher Weg",
    "Ulmenring",
    "Feldbergstraße",
];

/** Client companies. */
const COMPANIES: readonly Organisation[] = [
    { name: bi("Brightline GmbH"), domain: "brightline.example" },
    { name: bi("Thermo-Tech AG"), domain: "thermo-tech.example" },
    { name: bi("Nordbau GmbH"), domain: "nordbau.example" },
    { name: bi("Lumina Logistik"), domain: "lumina-logistik.example" },
    { name: bi("Kestrel Software"), domain: "kestrel.example" },
    { name: bi("Hansa Datenwerk"), domain: "datenwerk.example" },
    { name: bi("Feldmann Maschinenbau"), domain: "feldmann-mb.example" },
    { name: bi("Quellwerk Energie"), domain: "quellwerk.example" },
    { name: bi("Weidenhof Bio"), domain: "weidenhof.example" },
    { name: bi("Silberstreif Consulting"), domain: "silberstreif.example" },
    { name: bi("Datenhafen GmbH"), domain: "datenhafen.example" },
    { name: bi("Rotfuchs Medien"), domain: "rotfuchs.example" },
];

/** Associations. */
const ASSOCIATIONS: readonly Organisation[] = [
    {
        name: bi("Heimatverein Kaltenbach", "Kaltenbach local history society"),
        domain: "heimatverein-kaltenbach.example",
    },
    {
        name: bi("Imkerverein Hollerbach", "Hollerbach beekeepers' association"),
        domain: "imker-hollerbach.example",
    },
    {
        name: bi("Lauftreff Eschenrode", "Eschenrode running group"),
        domain: "lauftreff-eschenrode.example",
    },
    {
        name: bi("Gemischter Chor Wiesenfeld", "Wiesenfeld mixed choir"),
        domain: "chor-wiesenfeld.example",
    },
    {
        name: bi("Förderverein Freibad Kaltenbach", "Friends of the Kaltenbach open-air pool"),
        domain: "freibad-kaltenbach.example",
    },
    {
        name: bi("Obst- und Gartenbauverein Oberweiler", "Oberweiler fruit and garden club"),
        domain: "ogv-oberweiler.example",
    },
    {
        name: bi("Freiwillige Feuerwehr Rotenfels", "Rotenfels volunteer fire brigade"),
        domain: "ff-rotenfels.example",
    },
    {
        name: bi("Fotoclub Eschenrode", "Eschenrode photo club"),
        domain: "fotoclub-eschenrode.example",
    },
];

/** Schools of the crowd's children (never the persona's schools). */
const SCHOOLS = [
    bi("Grundschule Hollerbach", "Hollerbach primary school"),
    bi("Realschule Eschenrode", "Eschenrode secondary school"),
    bi("Gesamtschule Wiesenfeld", "Wiesenfeld comprehensive school"),
];

/** Children's first names of crowd parents. */
const KID_NAMES = [
    "Emil",
    "Finn",
    "Greta",
    "Jakob",
    "Lina",
    "Mats",
    "Marlies",
    "Oskar",
    "Pia",
    "Rosa",
    "Smilla",
    "Theo",
    "Vincent",
    "Wilma",
    "Zoe",
    "Anton",
    "Ella",
    "Hugo",
];

/** Craft trades: German female, German male, English, company prefix. */
const TRADES: readonly (readonly [string, string, string, string])[] = [
    ["Elektromeisterin", "Elektromeister", "master electrician", "Elektro"],
    ["Malerin", "Maler", "painter", "Malerbetrieb"],
    ["Dachdeckerin", "Dachdecker", "roofer", "Dachbau"],
    ["Schreinerin", "Schreiner", "joiner", "Schreinerei"],
    ["Installateurin", "Installateur", "plumber", "Haustechnik"],
    ["Gärtnerin", "Gärtner", "gardener", "Gartenbau"],
    ["Fliesenlegerin", "Fliesenleger", "tiler", "Fliesen"],
    ["Schornsteinfegerin", "Schornsteinfeger", "chimney sweep", "Kaminkehrer"],
];

/** Therapy and medical professions (no GP, dentist or eye doctor). */
const THERAPY_ROLES: readonly (readonly [string, string, string])[] = [
    ["Physiotherapeutin", "Physiotherapeut", "physiotherapist"],
    ["Osteopathin", "Osteopath", "osteopath"],
    ["Logopädin", "Logopäde", "speech therapist"],
    ["Kinderärztin", "Kinderarzt", "paediatrician"],
    ["Ergotherapeutin", "Ergotherapeut", "occupational therapist"],
    ["Orthopädin", "Orthopäde", "orthopaedist"],
];

/** Startups of crowd founders: name, German focus, English focus. */
const STARTUPS: readonly (readonly [string, string, string])[] = [
    ["Feldfunk", "Sensorik für Landwirtschaft", "sensors for agriculture"],
    ["Lernlicht", "Lernsoftware für Grundschulen", "learning software for primary schools"],
    ["Paketpause", "Abholstationen für Dörfer", "parcel lockers for villages"],
    ["Kiezkasse", "Kassensysteme für Hofläden", "point-of-sale systems for small shops"],
    ["Wolkenwerk", "Wetterdaten für Bauprojekte", "weather data for construction projects"],
    ["Fahrplanfux", "Mitfahr-App für Pendler", "ride-sharing app for commuters"],
    ["Ladenlicht", "Energiesparberatung für Läden", "energy saving advice for shops"],
];

/** Open-source projects of crowd developers. */
const OSS_PROJECTS = [
    "Feldpost",
    "Kalenderbrücke",
    "tinyqueue",
    "Wetterfrosch-API",
    "Rechnungsfuchs",
    "mdlint-de",
    "Taktgeber",
];

/** Former employers of former colleagues. */
const FORMER_EMPLOYERS = [
    "Systemhaus Kreuzberg",
    "Infotakt AG",
    "Meridian IT",
    "Datastrom GmbH",
    "Bergwerk Digital",
];

/** Handball teams of crowd children. */
const HANDBALL_TEAMS = ["E-Jugend", "D-Jugend", "C-Jugend", "B-Jugend"];

// ---------------------------------------------------------------- people

/**
 * Creates the 200 people: the seeded confusable ones plus random combinations, with unique
 * slugs that do not collide with any hand-written file.
 *
 * @param random - PRNG.
 * @param takenSlugs - Slugs of hand-written people files.
 * @returns The people.
 */
function createPeople(random: Random, takenSlugs: ReadonlySet<string>): Person[] {
    const roles: readonly Role[] = [
        "client",
        "client",
        "client",
        "schoolParent",
        "handballParent",
        "neighbour",
        "neighbour",
        "craftsperson",
        "therapist",
        "founder",
        "developer",
        "formerColleague",
        "association",
        "association",
    ];
    const slugs = new Set<string>();
    const people: Person[] = [];
    const add = (first: string, last: string, gender: Gender): void => {
        const slug = slugify(`${first} ${last}`);
        if (slugs.has(slug) || takenSlugs.has(slug)) {
            return;
        }
        slugs.add(slug);
        const role = random.pick(roles);
        people.push({
            first,
            last,
            gender,
            slug,
            role,
            town: random.pick(TOWNS),
            organisation: pickOrganisation(random, role, last),
            threads: [],
        });
    };
    for (const [first, last, gender] of SEEDED_PEOPLE) {
        add(first, last, gender);
    }
    while (people.length < PEOPLE_COUNT) {
        const gender: Gender = random.chance(0.5) ? "f" : "m";
        const first = random.pick(gender === "f" ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES);
        const last = random.chance(0.3)
            ? random.pick(CONFUSABLE_SURNAMES)
            : random.pick(GENERAL_SURNAMES);
        add(first, last, gender);
    }
    return people;
}

/**
 * Picks the organisation a person belongs to, depending on the role.
 *
 * @param random - PRNG.
 * @param role - The person's role.
 * @param last - The person's surname (craft businesses are named after it).
 * @returns The organisation.
 */
function pickOrganisation(random: Random, role: Role, last: string): Organisation {
    switch (role) {
        case "client":
            return random.pick(COMPANIES);
        case "association":
            return random.pick(ASSOCIATIONS);
        case "schoolParent":
            return { name: random.pick(SCHOOLS), domain: "schule.example" };
        case "handballParent":
            return { name: bi("TV Eschenrode, Handball"), domain: "tv-eschenrode.example" };
        case "craftsperson": {
            const trade = random.pick(TRADES);
            return {
                name: bi(`${trade[3]} ${last}`),
                domain: `${slugify(`${trade[3]}-${last}`)}.example`,
            };
        }
        case "therapist":
            return { name: bi(`Praxis ${last}`), domain: `praxis-${slugify(last)}.example` };
        case "founder": {
            const startup = random.pick(STARTUPS);
            return { name: bi(startup[0]), domain: `${slugify(startup[0])}.example` };
        }
        case "developer":
            return { name: bi(random.pick(OSS_PROJECTS)), domain: "dev.example" };
        case "formerColleague":
            return { name: bi(random.pick(FORMER_EMPLOYERS)), domain: "alumni.example" };
        case "neighbour":
            return {
                name: bi(`${random.pick(STREETS)} ${random.int(1, 40)}`),
                domain: "mail.example",
            };
    }
}

/**
 * Picks the German role noun for a gender.
 *
 * @param gender - Grammatical gender.
 * @param female - Female form.
 * @param male - Male form.
 * @returns The fitting form.
 */
function gendered(gender: Gender, female: string, male: string): string {
    return gender === "f" ? female : male;
}

/**
 * Builds the context sentence and relationship bullets of a person, by role.
 *
 * @param random - PRNG.
 * @param person - The person.
 * @returns The context sentence and relationship bullets.
 */
function describePerson(
    random: Random,
    person: Person,
): { readonly context: Bilingual; readonly relation: Bilingual[] } {
    const { gender, organisation: org, town } = person;
    switch (person.role) {
        case "client": {
            const titles: readonly (readonly [string, string, string])[] = [
                ["Projektleiterin", "Projektleiter", "project lead"],
                ["IT-Leiterin", "IT-Leiter", "head of IT"],
                ["Einkäuferin", "Einkäufer", "buyer"],
                ["Produktmanagerin", "Produktmanager", "product manager"],
                ["Geschäftsführerin", "Geschäftsführer", "managing director"],
                ["Werkstudentin", "Werkstudent", "working student"],
            ];
            const title = random.pick(titles);
            return {
                context: bi(
                    `${gendered(gender, title[0], title[1])} bei ${org.name.de} in ${town}; Kontakt aus einem Beratungsprojekt.`,
                    `${capitalize(title[2])} at ${org.name.en} in ${town}; contact from a consulting project.`,
                ),
                relation: [
                    bi(`- Arbeitet bei **${org.name.de}**`, `- Works at **${org.name.en}**`),
                    bi(
                        `- ${random.pick(["Entscheidet über Budget", "Fachlicher Ansprechpartner", "Koordiniert die Termine", "Prüft die Rechnungen"])}`,
                        `- ${random.pick(["Decides on budget", "Subject-matter contact", "Coordinates appointments", "Checks the invoices"])}`,
                    ),
                ],
            };
        }
        case "schoolParent": {
            const kid = random.pick(KID_NAMES);
            const grade = random.int(1, 10);
            return {
                context: bi(
                    `${gendered(gender, "Mutter", "Vater")} von ${kid} (${grade}. Klasse, ${org.name.de}).`,
                    `${gender === "f" ? "Mother" : "Father"} of ${kid} (year ${grade}, ${org.name.en}).`,
                ),
                relation: [
                    bi(
                        `- Kind: **${kid}**, ${grade}. Klasse`,
                        `- Child: **${kid}**, year ${grade}`,
                    ),
                    bi(`- Wohnt in ${town}`, `- Lives in ${town}`),
                ],
            };
        }
        case "handballParent": {
            const kid = random.pick(KID_NAMES);
            const team = random.pick(HANDBALL_TEAMS);
            return {
                context: bi(
                    `${gendered(gender, "Mutter", "Vater")} von ${kid}, ${team} Handball beim TV Eschenrode.`,
                    `${gender === "f" ? "Mother" : "Father"} of ${kid}, ${team} handball at TV Eschenrode.`,
                ),
                relation: [
                    bi(`- Kind: **${kid}** (${team})`, `- Child: **${kid}** (${team})`),
                    bi(
                        `- ${random.pick(["Organisiert die Fahrgemeinschaft", "Kassenwart der Elternkasse", "Fotografiert bei Heimspielen"])}`,
                        `- ${random.pick(["Organises the car pool", "Treasurer of the parents' fund", "Takes photos at home games"])}`,
                    ),
                ],
            };
        }
        case "neighbour":
            return {
                context: bi(
                    `${gendered(gender, "Nachbarin", "Nachbar")}, ${org.name.de} in ${town}.`,
                    `Neighbour at ${org.name.en}, ${town}.`,
                ),
                relation: [
                    bi(
                        `- Adresse: **${org.name.de}**, ${town}`,
                        `- Address: **${org.name.en}**, ${town}`,
                    ),
                    bi(
                        `- ${random.pick(["Nimmt Pakete an", "Hat einen Schlüssel für Notfälle", "Leiht gern Werkzeug aus", "Kümmert sich um die Hecke"])}`,
                        `- ${random.pick(["Accepts parcels", "Has a spare key for emergencies", "Happy to lend tools", "Looks after the hedge"])}`,
                    ),
                ],
            };
        case "craftsperson": {
            const trade = TRADES.find((entry) => org.name.de.startsWith(entry[3])) ?? TRADES[0];
            return {
                context: bi(
                    `${gendered(gender, trade[0], trade[1])}, Betrieb ${org.name.de} in ${town}.`,
                    `${capitalize(trade[2])}, business ${org.name.en} in ${town}.`,
                ),
                relation: [
                    bi(`- Firma: **${org.name.de}**`, `- Business: **${org.name.en}**`),
                    bi(
                        `- ${random.pick(["Zuverlässig, aber lange Wartezeiten", "Kommt meist pünktlich", "Schickt Angebote nur per Post", "Empfohlen von Nachbarn"])}`,
                        `- ${random.pick(["Reliable, but long waiting times", "Usually on time", "Sends quotes by post only", "Recommended by neighbours"])}`,
                    ),
                ],
            };
        }
        case "therapist": {
            const therapy = random.pick(THERAPY_ROLES);
            return {
                context: bi(
                    `${gendered(gender, therapy[0], therapy[1])}, ${org.name.de} in ${town}.`,
                    `${capitalize(therapy[2])}, ${org.name.en} in ${town}.`,
                ),
                relation: [
                    bi(
                        `- Praxis: **${org.name.de}**, ${town}`,
                        `- Practice: **${org.name.en}**, ${town}`,
                    ),
                    bi("- Bekannt über den Elternkreis", "- Known through other parents"),
                ],
            };
        }
        case "founder": {
            const startup = STARTUPS.find((entry) => entry[0] === org.name.de) ?? STARTUPS[0];
            return {
                context: bi(
                    `${gendered(gender, "Gründerin", "Gründer")} von ${startup[0]} (${startup[1]}), ${town}.`,
                    `Founder of ${startup[0]} (${startup[2]}), ${town}.`,
                ),
                relation: [
                    bi(
                        `- Startup: **${startup[0]}** — ${startup[1]}`,
                        `- Startup: **${startup[0]}** — ${startup[2]}`,
                    ),
                    bi(
                        "- Kennengelernt beim Startup-Frühstück Eschenrode",
                        "- Met at the Eschenrode startup breakfast",
                    ),
                ],
            };
        }
        case "developer":
            return {
                context: bi(
                    `${gendered(gender, "Softwareentwicklerin", "Softwareentwickler")} aus ${town}, betreut das Open-Source-Projekt ${org.name.de}.`,
                    `Software developer from ${town}, maintains the open-source project ${org.name.en}.`,
                ),
                relation: [
                    bi(`- Projekt: **${org.name.de}**`, `- Project: **${org.name.en}**`),
                    bi(
                        "- Trifft man bei der Linux-Usergroup Wiesenfeld",
                        "- Regular at the Wiesenfeld Linux user group",
                    ),
                ],
            };
        case "formerColleague": {
            const from = random.int(2009, 2015);
            return {
                context: bi(
                    `${gendered(gender, "Ehemalige Kollegin", "Ehemaliger Kollege")} bei ${org.name.de} (${from}–${from + random.int(2, 5)}).`,
                    `Former colleague at ${org.name.en} (${from}–${from + random.int(2, 5)}).`,
                ),
                relation: [
                    bi(`- Damals: **${org.name.de}**`, `- Back then: **${org.name.en}**`),
                    bi(`- Lebt heute in ${town}`, `- Lives in ${town} today`),
                ],
            };
        }
        case "association": {
            const functions: readonly (readonly [string, string, string])[] = [
                ["Vorsitzende", "Vorsitzender", "chair"],
                ["Kassiererin", "Kassierer", "treasurer"],
                ["Schriftführerin", "Schriftführer", "secretary"],
                ["Mitglied", "Mitglied", "member"],
            ];
            const fn = random.pick(functions);
            return {
                context: bi(
                    `${gendered(gender, fn[0], fn[1])} — ${org.name.de}.`,
                    `${capitalize(fn[2])} — ${org.name.en}.`,
                ),
                relation: [
                    bi(`- Verein: **${org.name.de}**`, `- Association: **${org.name.en}**`),
                    bi(`- Wohnt in ${town}`, `- Lives in ${town}`),
                ],
            };
        }
    }
}

/**
 * Upper-cases the first character.
 *
 * @param text - Any text.
 * @returns The text with a capital first letter.
 */
function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Interaction events per role: German and English text. */
const EVENTS: Readonly<Record<Role, readonly (readonly [string, string])[]>> = {
    client: [
        ["Angebot nachgefragt", "asked for a quote"],
        ["Kick-off-Termin vor Ort", "kick-off meeting on site"],
        ["Workshop zu den Anforderungen", "requirements workshop"],
        ["Rechnung freigegeben", "invoice approved"],
        ["Telefonat zum Projektstand", "call about the project status"],
        ["Termin verschoben", "meeting postponed"],
        ["Abnahme der ersten Phase", "first phase signed off"],
        ["Mail archiviert, im Digest vermerkt", "mail archived, noted in the digest"],
    ],
    schoolParent: [
        ["Elternabend, nebeneinander gesessen", "parents' evening, sat next to each other"],
        ["Fahrgemeinschaft zum Schwimmkurs abgesprochen", "agreed a car pool to swimming lessons"],
        ["Kuchen fürs Schulfest organisiert", "organised cakes for the school fair"],
        ["Wahl des Elternbeirats", "parents' council election"],
        ["Helfer beim Laternenumzug", "helper at the lantern parade"],
        ["Mail archiviert, im Digest vermerkt", "mail archived, noted in the digest"],
    ],
    handballParent: [
        ["Fahrdienst zum Auswärtsspiel", "driving to the away game"],
        ["Trikotwäsche übernommen", "took over washing the jerseys"],
        ["Kuchenverkauf beim Turnier", "cake sale at the tournament"],
        ["Saisonabschluss der Mannschaft", "team end-of-season party"],
        ["Hallenzeiten geändert, Info weitergegeben", "hall times changed, passed on the info"],
    ],
    neighbour: [
        ["Paket angenommen", "accepted a parcel"],
        ["Hecke schneiden abgesprochen", "agreed on cutting the hedge"],
        ["Grillabend im Hof", "barbecue in the yard"],
        ["Gerüst vor dem Haus angekündigt", "announced scaffolding in front of the house"],
        ["Sperrmüll gemeinsam angemeldet", "registered bulky waste together"],
        ["Katze entlaufen, Zettel verteilt", "cat ran away, handed out flyers"],
    ],
    craftsperson: [
        ["Kostenvoranschlag erhalten", "received a cost estimate"],
        ["Termin vor Ort", "on-site appointment"],
        ["Rechnung bezahlt", "invoice paid"],
        ["Nacharbeit vereinbart", "rework agreed"],
        ["Rückruf verpasst, Mail archiviert", "missed callback, mail archived"],
    ],
    therapist: [
        ["Vortrag beim Gesundheitstag der Gemeinde", "talk at the community health day"],
        ["Empfehlung an Bekannte weitergegeben", "passed a recommendation on to friends"],
        ["Praxisumzug angekündigt", "announced the practice move"],
        ["Neujahrsempfang der Gemeinde getroffen", "met at the town's new year reception"],
    ],
    founder: [
        ["Produktdemo per Video", "product demo by video"],
        ["Kaffee in der Altstadt", "coffee in the old town"],
        ["Feedback zur Landingpage gegeben", "gave feedback on the landing page"],
        ["Newsletter abonniert", "subscribed to the newsletter"],
        ["Startup-Frühstück Eschenrode", "Eschenrode startup breakfast"],
    ],
    developer: [
        ["Vortrag bei der Linux-Usergroup", "talk at the Linux user group"],
        ["Code-Review für einen Pull Request", "code review for a pull request"],
        ["Zusammen auf einer Konferenz", "at a conference together"],
        ["Issue zum Projekt kommentiert", "commented on a project issue"],
    ],
    formerColleague: [
        ["Ehemaligentreffen", "former colleagues' reunion"],
        ["Nachricht auf LinkedIn", "message on LinkedIn"],
        ["Empfehlung für eine Stelle geschrieben", "wrote a reference for a job"],
        ["Zufällig am Bahnhof getroffen", "met by chance at the station"],
    ],
    association: [
        ["Jahreshauptversammlung", "annual general meeting"],
        ["Arbeitseinsatz", "work day"],
        ["Mitgliedsbeitrag eingezogen", "membership fee collected"],
        ["Vereinsfest", "club party"],
        ["Rundmail archiviert, im Digest vermerkt", "circular mail archived, noted in the digest"],
    ],
};

/** Optional notes per person: German and English. */
const NOTES: readonly (readonly [string, string])[] = [
    [
        "Antwortet schnell per Mail, telefonisch schlecht erreichbar",
        "answers mails quickly, hard to reach by phone",
    ],
    ["Duzt alle", "on first-name terms with everyone"],
    ["Fährt nur Fahrrad", "cycles everywhere"],
    ["Spricht fließend Portugiesisch", "speaks fluent Portuguese"],
    ["Hat einen Schrebergarten", "has an allotment garden"],
    ["Mag keine Termine vor 9 Uhr", "dislikes meetings before 9 am"],
    ["Trinkt nur Tee", "drinks tea only"],
    ["Singt im Chor", "sings in a choir"],
    ["Bastelt an alten Radios", "tinkers with old radios"],
    ["Ist oft auf Dienstreise", "often travels for work"],
];

/**
 * Renders one person's file.
 *
 * @param random - PRNG.
 * @param person - The person, with thread links filled in.
 * @param dates - Date source.
 * @returns The generated file.
 */
function renderPerson(
    random: Random,
    person: Person,
    dates: (count: number) => string[],
): GeneratedFile {
    const { context, relation } = describePerson(random, person);
    const lines: Bilingual[] = [bi(`# ${person.first} ${person.last}`), bi(""), context, bi("")];
    lines.push(bi("## Beziehung", "## Relationship"), ...relation);
    for (const thread of person.threads) {
        lines.push(
            bi(
                `- Siehe [[threads/${thread.slug.de}|${thread.title.de}]]`,
                `- See [[threads/${thread.slug.en}|${thread.title.en}]]`,
            ),
        );
    }
    if (random.chance(0.6)) {
        const user = slugify(person.first).replaceAll("-", "");
        lines.push(
            bi(""),
            bi("## Kontakt", "## Contact"),
            bi(
                `- E-Mail: ${user}.${slugify(person.last)}@${person.organisation.domain}`,
                `- Email: ${user}.${slugify(person.last)}@${person.organisation.domain}`,
            ),
        );
        if (random.chance(0.5)) {
            const phone = `0${random.int(2000, 9999)} ${random.int(100, 999)} ${random.int(10, 99)}`;
            lines.push(bi(`- Telefon: ${phone}`, `- Phone: ${phone}`));
        }
    }
    const events = pickInOrder(
        random,
        EVENTS[person.role],
        random.int(1, Math.min(6, EVENTS[person.role].length)),
    );
    const eventDates = dates(events.length);
    lines.push(bi(""), bi("## Verlauf", "## History"));
    events.forEach((event, index) => {
        lines.push(
            bi(
                `- **${eventDates[index]}**: ${event[0]}`,
                `- **${eventDates[index]}**: ${capitalize(event[1])}`,
            ),
        );
    });
    if (random.chance(0.45)) {
        lines.push(bi(""), bi("## Notizen", "## Notes"));
        for (const note of random.shuffle(NOTES).slice(0, random.int(1, 3))) {
            lines.push(bi(`- ${note[0]}`, `- ${capitalize(note[1])}`));
        }
    }
    return toFile(bi(`wiki/people/${person.slug}.md`), lines);
}

/**
 * Picks `count` distinct items at random but keeps their original order, so event pools listed
 * in a plausible sequence (offer → order → invoice) stay plausible after dating.
 *
 * @param random - PRNG.
 * @param items - The pool, in plausible order.
 * @param count - Number of items to pick (capped at the pool size).
 * @returns The picked items in pool order.
 */
function pickInOrder<T>(random: Random, items: readonly T[], count: number): T[] {
    const indices = random
        .shuffle(items.map((_, index) => index))
        .slice(0, count)
        .sort((a, b) => a - b);
    return indices.map((index) => items[index]);
}

/**
 * Joins bilingual lines into a generated file.
 *
 * @param filePath - Path per language.
 * @param lines - Lines per language.
 * @returns The generated file.
 */
function toFile(filePath: Bilingual, lines: readonly Bilingual[]): GeneratedFile {
    return {
        path: filePath,
        content: {
            de: `${lines.map((line) => line.de).join("\n")}\n`,
            en: `${lines.map((line) => line.en).join("\n")}\n`,
        },
    };
}

// ---------------------------------------------------------------- threads

/** A planned thread before rendering. */
interface ThreadPlan {
    readonly slug: Bilingual;
    readonly title: Bilingual;
    readonly context: Bilingual;
    readonly participants: readonly Person[];
    /** Section heading and event pool for the dated history. */
    readonly events: readonly (readonly [string, string])[];
    /** Extra static bullets (status, amounts, tracking numbers). */
    readonly facts: readonly Bilingual[];
}

/**
 * Picks up to `count` people matching a filter, preferring people with few thread links.
 *
 * @param random - PRNG.
 * @param people - All people.
 * @param filter - Which people qualify.
 * @param count - Maximum number to pick.
 * @returns The picked people.
 */
function pickParticipants(
    random: Random,
    people: readonly Person[],
    filter: (person: Person) => boolean,
    count: number,
): Person[] {
    return random
        .shuffle(people.filter(filter))
        .sort((a, b) => a.threads.length - b.threads.length)
        .slice(0, count);
}

/**
 * Plans the 100 threads and links participants back to them.
 *
 * @param random - PRNG.
 * @param people - All people (their `threads` lists are filled).
 * @param takenSlugs - Thread slugs per language that already exist (hand-written).
 * @returns The thread plans.
 */
function planThreads(
    random: Random,
    people: readonly Person[],
    takenSlugs: Readonly<Record<Language, ReadonlySet<string>>>,
): ThreadPlan[] {
    const plans: ThreadPlan[] = [];
    const used = { de: new Set<string>(), en: new Set<string>() };
    const add = (plan: ThreadPlan): void => {
        const isTaken = LANGUAGES.some(
            (language) =>
                used[language].has(plan.slug[language]) ||
                takenSlugs[language].has(plan.slug[language]),
        );
        if (isTaken) {
            return;
        }
        used.de.add(plan.slug.de);
        used.en.add(plan.slug.en);
        plans.push(plan);
        for (const person of plan.participants) {
            person.threads.push({ slug: plan.slug, title: plan.title });
        }
    };

    // Client projects (20).
    const topics: readonly (readonly [string, string])[] = [
        ["Intranet-Relaunch", "Intranet relaunch"],
        ["CRM-Einführung", "CRM rollout"],
        ["Lagerverwaltung", "Warehouse management"],
        ["Website-Umbau", "Website rebuild"],
        ["Datenschutz-Audit", "Data protection audit"],
        ["Schulungsreihe", "Training series"],
        ["Ticketsystem", "Ticketing system"],
        ["Prozessanalyse Einkauf", "Purchasing process analysis"],
    ];
    const projectEvents: readonly (readonly [string, string])[] = [
        ["Angebot verschickt", "quote sent"],
        ["Auftrag erteilt", "order placed"],
        ["Kick-off", "kick-off"],
        ["Workshop mit der Fachabteilung", "workshop with the department"],
        ["Zwischenstand präsentiert", "progress presented"],
        ["Rechnung gestellt", "invoice sent"],
        ["Mail archiviert, im Digest vermerkt", "mail archived, noted in the digest"],
        [
            "Nachtrag: dieselbe Benachrichtigung erneut zugestellt",
            "addendum: the same notification delivered again",
        ],
    ];
    for (const company of random.shuffle(COMPANIES)) {
        for (const topic of random.shuffle(topics).slice(0, 2)) {
            if (plans.length >= 20) {
                break;
            }
            add({
                slug: bi(
                    `projekt-${slugify(company.name.de)}-${slugify(topic[0])}`,
                    `project-${slugify(company.name.en)}-${slugify(topic[1])}`,
                ),
                title: bi(`${company.name.de}: ${topic[0]}`, `${company.name.en}: ${topic[1]}`),
                context: bi(
                    `Beratungsprojekt für ${company.name.de}: ${topic[0]}.`,
                    `Consulting project for ${company.name.en}: ${topic[1].toLowerCase()}.`,
                ),
                participants: pickParticipants(
                    random,
                    people,
                    (person) => person.role === "client" && person.organisation === company,
                    random.int(1, 3),
                ),
                events: projectEvents,
                facts: [
                    bi(
                        `- Umfang: **${random.int(5, 40)} Beratertage**`,
                        `- Scope: **${random.int(5, 40)} consulting days**`,
                    ),
                    bi(
                        `- Stand: ${random.pick(["läuft", "abgeschlossen", "pausiert"])}`,
                        `- Status: ${random.pick(["running", "completed", "paused"])}`,
                    ),
                ],
            });
        }
    }

    // Associations (8).
    for (const association of ASSOCIATIONS) {
        add({
            slug: bi(slugify(association.name.de), slugify(association.name.en)),
            title: association.name,
            context: bi(
                `Notizen: ${association.name.de} — Termine, Kontakte, Beiträge.`,
                `Notes: ${association.name.en} — dates, contacts, fees.`,
            ),
            participants: pickParticipants(
                random,
                people,
                (person) => person.organisation === association,
                4,
            ),
            events: EVENTS.association,
            facts: [
                bi(
                    `- Jahresbeitrag: **${random.int(12, 60)} €**`,
                    `- Annual fee: **${random.int(12, 60)} €**`,
                ),
            ],
        });
    }

    // Neighbour renovations (12).
    const renovationEvents: readonly (readonly [string, string])[] = [
        ["Gerüst aufgebaut", "scaffolding put up"],
        ["Lärm ab 7 Uhr angekündigt", "noise from 7 am announced"],
        ["Container auf dem Parkplatz", "skip on the car park"],
        ["Fassade gestrichen", "facade painted"],
        ["Fenster getauscht", "windows replaced"],
        ["Heizungstausch beim Nachbarn", "neighbour's heating replaced"],
        ["Bauabnahme", "building inspection"],
    ];
    for (const street of random.shuffle(STREETS)) {
        const number = random.int(1, 40);
        add({
            slug: bi(
                `sanierung-${slugify(street)}-${number}`,
                `renovation-${slugify(street)}-${number}`,
            ),
            title: bi(`Sanierung ${street} ${number}`, `Renovation ${street} ${number}`),
            context: bi(
                `Sanierung des Nachbarhauses ${street} ${number}: Absprachen, Lärm, Parkplätze.`,
                `Renovation of the neighbouring house ${street} ${number}: arrangements, noise, parking.`,
            ),
            participants: [
                ...pickParticipants(random, people, (person) => person.role === "neighbour", 1),
                ...pickParticipants(
                    random,
                    people,
                    (person) => person.role === "craftsperson",
                    random.int(1, 2),
                ),
            ],
            events: renovationEvents,
            facts: [
                bi(
                    `- Dauer laut Bauschild: **${random.int(3, 14)} Wochen**`,
                    `- Duration according to the site sign: **${random.int(3, 14)} weeks**`,
                ),
            ],
        });
    }
    for (let index = 0; plans.length < 40 && index < 10; index++) {
        const street = random.pick(STREETS);
        const number = random.int(41, 90);
        add({
            slug: bi(
                `sanierung-${slugify(street)}-${number}`,
                `renovation-${slugify(street)}-${number}`,
            ),
            title: bi(`Sanierung ${street} ${number}`, `Renovation ${street} ${number}`),
            context: bi(
                `Umbau im Haus ${street} ${number}, betrifft die Nachbarschaft.`,
                `Conversion at ${street} ${number}, affects the neighbourhood.`,
            ),
            participants: pickParticipants(
                random,
                people,
                (person) => person.role === "craftsperson",
                1,
            ),
            events: renovationEvents,
            facts: [],
        });
    }

    // Contracts (14).
    const contracts: readonly (readonly [string, string, string])[] = [
        ["Hausratversicherung", "Household insurance", "Talgrund Versicherung"],
        ["Haftpflichtversicherung", "Liability insurance", "Talgrund Versicherung"],
        ["Rechtsschutzversicherung", "Legal expenses insurance", "Wegweiser Rechtsschutz"],
        ["Stromvertrag", "Electricity contract", "Quellwerk Energie"],
        ["Gasvertrag", "Gas contract", "Stadtwerke Eschenrode"],
        ["Glasfaseranschluss", "Fibre connection", "Lichtleiter Hessen"],
        ["Zeitungsabo", "Newspaper subscription", "Kaltenbacher Anzeiger"],
        ["Fitnessstudio-Vertrag", "Gym contract", "Kraftraum Kaltenbach"],
        ["Wohngebäudeversicherung", "Buildings insurance", "Talgrund Versicherung"],
        ["Streaming-Abo", "Streaming subscription", "Flimmerkiste+"],
        ["Fahrradversicherung", "Bicycle insurance", "Speiche & Co."],
        ["Bahncard", "Rail card", "Bahn"],
        ["Musikschule", "Music school", "Musikschule Wiesenfeld"],
        ["Bibliotheksausweis", "Library card", "Stadtbücherei Kaltenbach"],
    ];
    const contractEvents: readonly (readonly [string, string])[] = [
        ["Vertrag abgeschlossen", "contract signed"],
        ["Beitragserhöhung angekündigt", "price increase announced"],
        ["Kündigungsfrist geprüft", "notice period checked"],
        ["Rechnung erhalten, Mail archiviert", "invoice received, mail archived"],
        ["Kundenservice angerufen", "called customer service"],
        [
            "Nachtrag: dieselbe Rechnung erneut zugestellt",
            "addendum: the same invoice delivered again",
        ],
    ];
    for (const contract of contracts) {
        add({
            slug: bi(slugify(contract[0]), slugify(contract[1])),
            title: bi(contract[0], contract[1]),
            context: bi(
                `${contract[0]} bei ${contract[2]}: Konditionen und Schriftverkehr.`,
                `${contract[1]} with ${contract[2]}: terms and correspondence.`,
            ),
            participants: [],
            events: contractEvents,
            facts: [
                bi(`- Anbieter: **${contract[2]}**`, `- Provider: **${contract[2]}**`),
                bi(
                    `- Beitrag: ${random.int(4, 60)},${random.int(10, 99)} € pro Monat`,
                    `- Fee: ${random.int(4, 60)}.${random.int(10, 99)} € per month`,
                ),
                bi(
                    `- Vertragsnummer: ${random.int(100000, 999999)}-${random.int(10, 99)}`,
                    `- Contract number: ${random.int(100000, 999999)}-${random.int(10, 99)}`,
                ),
            ],
        });
    }

    // Events and groups.
    const happenings: readonly (readonly [string, string, Role | null])[] = [
        ["Straßenfest Kastanienweg", "Kastanienweg street party", "neighbour"],
        ["Flohmarkt Eschenrode", "Eschenrode flea market", null],
        ["Stadtlauf Kaltenbach", "Kaltenbach town run", "association"],
        ["Weinfest Oberweiler", "Oberweiler wine festival", null],
        ["Laternenumzug Hollerbach", "Hollerbach lantern parade", "schoolParent"],
        ["Klassenfahrt der 6b", "Year 6 class trip", "schoolParent"],
        ["Handballturnier TV Eschenrode", "TV Eschenrode handball tournament", "handballParent"],
        ["Chorkonzert Wiesenfeld", "Wiesenfeld choir concert", "association"],
        ["Linux-Usergroup Wiesenfeld", "Wiesenfeld Linux user group", "developer"],
        ["Startup-Frühstück Eschenrode", "Eschenrode startup breakfast", "founder"],
        ["Ehemaligentreffen Infotakt", "Infotakt former colleagues' reunion", "formerColleague"],
        [
            "Ehemaligentreffen Meridian IT",
            "Meridian IT former colleagues' reunion",
            "formerColleague",
        ],
        ["Gesundheitstag der Gemeinde", "Community health day", "therapist"],
        ["Repair-Café Rotenfels", "Rotenfels repair café", "craftsperson"],
        [
            "Elternbeirat Realschule Eschenrode",
            "Eschenrode secondary school parents' council",
            "schoolParent",
        ],
        ["Fahrgemeinschaft Handball", "Handball car pool", "handballParent"],
        ["Nachbarschaftshilfe Kastanienweg", "Kastanienweg neighbourhood help", "neighbour"],
        ["Open-Source-Sprint Taktgeber", "Taktgeber open-source sprint", "developer"],
        ["Weihnachtsmarkt Kaltenbach", "Kaltenbach Christmas market", "association"],
        ["Dorfputz Hollerbach", "Hollerbach village clean-up", "association"],
        ["Tag der offenen Tür Thermo-Tech", "Thermo-Tech open day", "client"],
        ["Sommerfeld-Grillfest", "Sommerfeld barbecue", null],
    ];
    const happeningEvents: readonly (readonly [string, string])[] = [
        ["Einladung erhalten", "invitation received"],
        ["Helferliste herumgeschickt", "volunteer list sent round"],
        ["Termin bestätigt", "date confirmed"],
        ["Ort geändert", "venue changed"],
        ["Fotos geteilt", "photos shared"],
        ["Rundmail archiviert, im Digest vermerkt", "circular mail archived, noted in the digest"],
    ];
    for (const happening of happenings) {
        const year = random.int(2024, 2026);
        add({
            slug: bi(`${slugify(happening[0])}-${year}`, `${slugify(happening[1])}-${year}`),
            title: bi(`${happening[0]} ${year}`, `${happening[1]} ${year}`),
            context: bi(
                `${happening[0]} ${year}: Organisation und Beteiligte.`,
                `${happening[1]} ${year}: organisation and people involved.`,
            ),
            participants:
                happening[2] === null
                    ? pickParticipants(random, people, () => true, random.int(1, 3))
                    : pickParticipants(
                          random,
                          people,
                          (person) => person.role === happening[2],
                          random.int(1, 4),
                      ),
            events: happeningEvents,
            facts: [],
        });
    }

    // Orders and packages (fill to 100).
    const products: readonly (readonly [string, string])[] = [
        ["Bürostuhl", "Office chair"],
        ["Gartenbank", "Garden bench"],
        ["Kaffeemühle", "Coffee grinder"],
        ["Fahrradschloss", "Bike lock"],
        ["Wanderschuhe", "Hiking boots"],
        ["Bluetooth-Lautsprecher", "Bluetooth speaker"],
        ["Akkubohrer", "Cordless drill"],
        ["Schreibtischlampe", "Desk lamp"],
        ["Regenjacke", "Rain jacket"],
        ["Vogelhaus", "Bird house"],
        ["Rasenmäher-Messer", "Lawn mower blade"],
        ["Thermoskanne", "Vacuum flask"],
        ["Hängematte", "Hammock"],
        ["Werkzeugkoffer", "Toolbox"],
        ["Monitorhalterung", "Monitor arm"],
        ["Wasserfilter", "Water filter"],
        ["Bettwäsche", "Bed linen"],
        ["Kinderfahrradhelm", "Kids' bike helmet"],
        ["Pflanzkübel", "Planter"],
        ["USB-Dockingstation", "USB docking station"],
        ["Fußmatte", "Doormat"],
        ["Kochbuch", "Cookbook"],
        ["Zelt", "Tent"],
        ["Schneeschaufel", "Snow shovel"],
        ["Teppich", "Rug"],
        ["Rucksack", "Backpack"],
    ];
    const carriers = ["Kurierwerk", "Logistiq", "PostNova"];
    const shops = [
        "Hausfreund",
        "Werkbank24",
        "Gartenglück",
        "Bürowelt Direkt",
        "Kaltenbacher Kaufhaus",
    ];
    const packageEvents: readonly (readonly [string, string])[] = [
        ["Bestellbestätigung per E-Mail", "order confirmation by email"],
        ["Versandbenachrichtigung", "shipping notification"],
        ["Sendung in Zustellung", "parcel out for delivery"],
        ["Zustellung erfolgreich, Mail archiviert", "delivered, mail archived"],
        ["Beim Nachbarn abgegeben", "left with a neighbour"],
        [
            "Nachtrag: dieselbe Benachrichtigung erneut zugestellt",
            "addendum: the same notification delivered again",
        ],
    ];
    for (const product of random.shuffle(products)) {
        if (plans.length >= 100) {
            break;
        }
        const carrier = random.pick(carriers);
        const shop = random.pick(shops);
        const tracking = `${carrier.slice(0, 2).toUpperCase()}${random.int(10000000, 99999999)}${random.int(100, 999)}`;
        add({
            slug: bi(`bestellung-${slugify(product[0])}`, `order-${slugify(product[1])}`),
            title: bi(`Bestellung ${product[0]}`, `Order ${product[1].toLowerCase()}`),
            context: bi(
                `Bestellung „${product[0]}" bei ${shop}, Versand mit ${carrier}.`,
                `Order of a ${product[1].toLowerCase()} from ${shop}, shipped by ${carrier}.`,
            ),
            participants: random.chance(0.3)
                ? pickParticipants(random, people, (person) => person.role === "neighbour", 1)
                : [],
            events: packageEvents,
            facts: [
                bi(`- Sendungsnummer: ${tracking}`, `- Tracking number: ${tracking}`),
                bi(
                    `- Betrag: ${random.int(9, 240)},${random.int(10, 99)} €`,
                    `- Amount: ${random.int(9, 240)}.${random.int(10, 99)} €`,
                ),
            ],
        });
    }
    if (plans.length !== 100) {
        throw new Error(`crowd: planned ${plans.length} threads, expected 100 — extend the pools`);
    }
    return plans;
}

/**
 * Renders one thread file.
 *
 * @param random - PRNG.
 * @param plan - The thread plan.
 * @param dates - Date source.
 * @returns The generated file.
 */
function renderThread(
    random: Random,
    plan: ThreadPlan,
    dates: (count: number) => string[],
): GeneratedFile {
    const lines: Bilingual[] = [
        bi(`# ${plan.title.de}`, `# ${plan.title.en}`),
        bi(""),
        plan.context,
    ];
    if (plan.facts.length > 0 || plan.participants.length > 0) {
        lines.push(bi(""), bi("## Überblick", "## Overview"), ...plan.facts);
        for (const person of plan.participants) {
            const name = `${person.first} ${person.last}`;
            lines.push(
                bi(
                    `- Beteiligt: [[people/${person.slug}|${name}]]`,
                    `- Involved: [[people/${person.slug}|${name}]]`,
                ),
            );
        }
    }
    const events = pickInOrder(random, plan.events, random.int(2, Math.min(7, plan.events.length)));
    const eventDates = dates(events.length);
    lines.push(bi(""), bi("## Verlauf", "## History"));
    events.forEach((event, index) => {
        lines.push(
            bi(
                `- **${eventDates[index]}**: ${event[0]}`,
                `- **${eventDates[index]}**: ${capitalize(event[1])}`,
            ),
        );
    });
    return toFile(bi(`wiki/threads/${plan.slug.de}.md`, `wiki/threads/${plan.slug.en}.md`), lines);
}

// ---------------------------------------------------------------- checks and output

/**
 * Throws when any generated text contains a forbidden term or a file has an unexpected length.
 *
 * @param files - All generated files.
 * @throws {Error} Naming the file, language and term of the first violation.
 */
function assertClean(files: readonly GeneratedFile[]): void {
    const matchers = compileForbiddenTerms();
    for (const file of files) {
        for (const language of LANGUAGES) {
            const text = file.content[language];
            for (const { term, pattern } of matchers) {
                const match = pattern.exec(text);
                if (match) {
                    throw new Error(
                        `crowd: forbidden term "${term}" ("${match[0]}") in ${language}/${file.path[language]}`,
                    );
                }
            }
            const lineCount = text.trimEnd().split("\n").length;
            if (lineCount < 6 || lineCount > 40) {
                throw new Error(
                    `crowd: ${language}/${file.path[language]} has ${lineCount} lines, expected 6–40`,
                );
            }
        }
    }
}

/**
 * Throws when a generated text contains a forbidden date.
 *
 * @param files - All generated files.
 * @param isForbidden - Forbidden-date predicate.
 * @throws {Error} Naming the file and date.
 */
function assertNoForbiddenDates(
    files: readonly GeneratedFile[],
    isForbidden: (iso: string) => boolean,
): void {
    for (const file of files) {
        for (const language of LANGUAGES) {
            for (const match of file.content[language].matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
                if (isForbidden(match[0])) {
                    throw new Error(
                        `crowd: forbidden date ${match[0]} in ${language}/${file.path[language]}`,
                    );
                }
            }
        }
    }
}

/**
 * Lists the markdown files of a corpus, relative to the corpus root.
 *
 * @param corpusDir - Absolute path of `corpus/<lang>/`.
 * @returns Relative POSIX paths.
 */
function listMarkdownFiles(corpusDir: string): Set<string> {
    const entries = fs.readdirSync(corpusDir, { recursive: true, withFileTypes: true });
    return new Set(
        entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
            .map((entry) =>
                path
                    .relative(corpusDir, path.join(entry.parentPath, entry.name))
                    .split(path.sep)
                    .join("/"),
            ),
    );
}

/**
 * Reads the previous manifest of a corpus.
 *
 * @param corpusDir - Absolute path of `corpus/<lang>/`.
 * @returns The relative paths written by the previous run (empty when there was none).
 * @throws {Error} When the manifest exists but is not a JSON list of strings.
 */
function readManifest(corpusDir: string): string[] {
    const manifestPath = path.join(corpusDir, ".crowd-manifest.json");
    if (!fs.existsSync(manifestPath)) {
        return [];
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
        throw new Error(`crowd: ${manifestPath} is not a JSON list of paths`);
    }
    return parsed;
}

/**
 * Generates the crowd and writes it to both corpora.
 *
 * @throws {Error} On any rule violation or file collision; nothing is written in that case.
 */
function main(): void {
    const evalDir = path.dirname(new URL(import.meta.url).pathname);
    const corpusDirs = {
        de: path.join(evalDir, "corpus", "de"),
        en: path.join(evalDir, "corpus", "en"),
    };
    const previous = { de: readManifest(corpusDirs.de), en: readManifest(corpusDirs.en) };
    const handWritten = {
        de: new Set(
            [...listMarkdownFiles(corpusDirs.de)].filter((file) => !previous.de.includes(file)),
        ),
        en: new Set(
            [...listMarkdownFiles(corpusDirs.en)].filter((file) => !previous.en.includes(file)),
        ),
    };
    const slugsIn = (language: Language, folder: string): Set<string> =>
        new Set(
            [...handWritten[language]]
                .filter((file) => file.startsWith(`wiki/${folder}/`))
                .map((file) => file.slice(`wiki/${folder}/`.length, -".md".length)),
        );

    const random = createRandom(SEED);
    const isForbiddenDate = buildForbiddenDatePredicate(evalDir);
    const dates = createDateSource(random, isForbiddenDate);
    const people = createPeople(
        random,
        new Set([...slugsIn("de", "people"), ...slugsIn("en", "people")]),
    );
    const threads = planThreads(random, people, {
        de: slugsIn("de", "threads"),
        en: slugsIn("en", "threads"),
    });
    const files = [
        ...people.map((person) => renderPerson(random, person, dates)),
        ...threads.map((plan) => renderThread(random, plan, dates)),
    ];

    assertClean(files);
    assertNoForbiddenDates(files, isForbiddenDate);
    for (const language of LANGUAGES) {
        for (const file of files) {
            if (handWritten[language].has(file.path[language])) {
                throw new Error(
                    `crowd: ${language}/${file.path[language]} would overwrite a hand-written file`,
                );
            }
        }
    }

    for (const language of LANGUAGES) {
        const corpusDir = corpusDirs[language];
        for (const relativePath of previous[language]) {
            fs.rmSync(path.join(corpusDir, relativePath), { force: true });
        }
        const written: string[] = [];
        for (const file of files) {
            const target = path.join(corpusDir, file.path[language]);
            if (fs.existsSync(target)) {
                throw new Error(
                    `crowd: refusing to overwrite ${language}/${file.path[language]}, which is not in the manifest`,
                );
            }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, file.content[language]);
            written.push(file.path[language]);
        }
        fs.writeFileSync(
            path.join(corpusDir, ".crowd-manifest.json"),
            `${JSON.stringify(written.sort(), null, 2)}\n`,
        );
        process.stdout.write(
            `crowd: wrote ${written.length} files to corpus/${language}/ (${people.length} people, ${threads.length} threads)\n`,
        );
    }
}

main();
