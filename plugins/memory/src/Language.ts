import type { Logger } from "@getfamiliar/shared";
import { stemmer as arabicStem } from "@orama/stemmers/arabic";
import { stemmer as armenianStem } from "@orama/stemmers/armenian";
import { stemmer as bulgarianStem } from "@orama/stemmers/bulgarian";
import { stemmer as danishStem } from "@orama/stemmers/danish";
import { stemmer as dutchStem } from "@orama/stemmers/dutch";
import { stemmer as englishStem } from "@orama/stemmers/english";
import { stemmer as finnishStem } from "@orama/stemmers/finnish";
import { stemmer as frenchStem } from "@orama/stemmers/french";
import { stemmer as germanStem } from "@orama/stemmers/german";
import { stemmer as greekStem } from "@orama/stemmers/greek";
import { stemmer as hungarianStem } from "@orama/stemmers/hungarian";
import { stemmer as indianStem } from "@orama/stemmers/indian";
import { stemmer as indonesianStem } from "@orama/stemmers/indonesian";
import { stemmer as irishStem } from "@orama/stemmers/irish";
import { stemmer as italianStem } from "@orama/stemmers/italian";
import { stemmer as lithuanianStem } from "@orama/stemmers/lithuanian";
import { stemmer as nepaliStem } from "@orama/stemmers/nepali";
import { stemmer as norwegianStem } from "@orama/stemmers/norwegian";
import { stemmer as portugueseStem } from "@orama/stemmers/portuguese";
import { stemmer as romanianStem } from "@orama/stemmers/romanian";
import { stemmer as russianStem } from "@orama/stemmers/russian";
import { stemmer as sanskritStem } from "@orama/stemmers/sanskrit";
import { stemmer as serbianStem } from "@orama/stemmers/serbian";
import { stemmer as spanishStem } from "@orama/stemmers/spanish";
import { stemmer as swedishStem } from "@orama/stemmers/swedish";
import { stemmer as tamilStem } from "@orama/stemmers/tamil";
import { stemmer as turkishStem } from "@orama/stemmers/turkish";
import { stemmer as ukrainianStem } from "@orama/stemmers/ukrainian";
import { stopwords as arabicSW } from "@orama/stopwords/arabic";
import { stopwords as armenianSW } from "@orama/stopwords/armenian";
import { stopwords as bulgarianSW } from "@orama/stopwords/bulgarian";
import { stopwords as danishSW } from "@orama/stopwords/danish";
import { stopwords as dutchSW } from "@orama/stopwords/dutch";
import { stopwords as englishSW } from "@orama/stopwords/english";
import { stopwords as finnishSW } from "@orama/stopwords/finnish";
import { stopwords as frenchSW } from "@orama/stopwords/french";
import { stopwords as germanSW } from "@orama/stopwords/german";
import { stopwords as greekSW } from "@orama/stopwords/greek";
import { stopwords as hungarianSW } from "@orama/stopwords/hungarian";
import { stopwords as indianSW } from "@orama/stopwords/indian";
import { stopwords as indonesianSW } from "@orama/stopwords/indonesian";
import { stopwords as irishSW } from "@orama/stopwords/irish";
import { stopwords as italianSW } from "@orama/stopwords/italian";
import { stopwords as lithuanianSW } from "@orama/stopwords/lithuanian";
import { stopwords as nepaliSW } from "@orama/stopwords/nepali";
import { stopwords as norwegianSW } from "@orama/stopwords/norwegian";
import { stopwords as portugueseSW } from "@orama/stopwords/portuguese";
import { stopwords as romanianSW } from "@orama/stopwords/romanian";
import { stopwords as russianSW } from "@orama/stopwords/russian";
import { stopwords as sanskritSW } from "@orama/stopwords/sanskrit";
import { stopwords as serbianSW } from "@orama/stopwords/serbian";
import { stopwords as spanishSW } from "@orama/stopwords/spanish";
import { stopwords as swedishSW } from "@orama/stopwords/swedish";
import { stopwords as tamilSW } from "@orama/stopwords/tamil";
import { stopwords as turkishSW } from "@orama/stopwords/turkish";
import { stopwords as ukrainianSW } from "@orama/stopwords/ukrainian";

/** One language's tokenizer ingredients ready to hand Orama. */
export interface LanguagePack {
    /**
     * Canonical name used by Orama's tokenizer for splitter selection
     * (`english`, `german`, …). Always one of {@link SUPPORTED_LANGUAGES}.
     */
    readonly name: string;
    readonly stemmer: (word: string) => string;
    readonly stopwords: readonly string[];
}

/**
 * Languages with both a stemmer **and** a stopword list shipped by
 * `@orama/stemmers` + `@orama/stopwords` **and** known to Orama's
 * tokenizer. Czech and slovenian are excluded — Orama supports them
 * but they lack a corresponding stemmer file.
 */
const PACKS: Readonly<Record<string, LanguagePack>> = {
    arabic: { name: "arabic", stemmer: arabicStem, stopwords: arabicSW },
    armenian: { name: "armenian", stemmer: armenianStem, stopwords: armenianSW },
    bulgarian: { name: "bulgarian", stemmer: bulgarianStem, stopwords: bulgarianSW },
    danish: { name: "danish", stemmer: danishStem, stopwords: danishSW },
    dutch: { name: "dutch", stemmer: dutchStem, stopwords: dutchSW },
    english: { name: "english", stemmer: englishStem, stopwords: englishSW },
    finnish: { name: "finnish", stemmer: finnishStem, stopwords: finnishSW },
    french: { name: "french", stemmer: frenchStem, stopwords: frenchSW },
    german: { name: "german", stemmer: germanStem, stopwords: germanSW },
    greek: { name: "greek", stemmer: greekStem, stopwords: greekSW },
    hungarian: { name: "hungarian", stemmer: hungarianStem, stopwords: hungarianSW },
    indian: { name: "indian", stemmer: indianStem, stopwords: indianSW },
    indonesian: { name: "indonesian", stemmer: indonesianStem, stopwords: indonesianSW },
    irish: { name: "irish", stemmer: irishStem, stopwords: irishSW },
    italian: { name: "italian", stemmer: italianStem, stopwords: italianSW },
    lithuanian: { name: "lithuanian", stemmer: lithuanianStem, stopwords: lithuanianSW },
    nepali: { name: "nepali", stemmer: nepaliStem, stopwords: nepaliSW },
    norwegian: { name: "norwegian", stemmer: norwegianStem, stopwords: norwegianSW },
    portuguese: { name: "portuguese", stemmer: portugueseStem, stopwords: portugueseSW },
    romanian: { name: "romanian", stemmer: romanianStem, stopwords: romanianSW },
    russian: { name: "russian", stemmer: russianStem, stopwords: russianSW },
    sanskrit: { name: "sanskrit", stemmer: sanskritStem, stopwords: sanskritSW },
    serbian: { name: "serbian", stemmer: serbianStem, stopwords: serbianSW },
    spanish: { name: "spanish", stemmer: spanishStem, stopwords: spanishSW },
    swedish: { name: "swedish", stemmer: swedishStem, stopwords: swedishSW },
    tamil: { name: "tamil", stemmer: tamilStem, stopwords: tamilSW },
    turkish: { name: "turkish", stemmer: turkishStem, stopwords: turkishSW },
    ukrainian: { name: "ukrainian", stemmer: ukrainianStem, stopwords: ukrainianSW },
};

/** Sorted for deterministic error messages. */
export const SUPPORTED_LANGUAGES: readonly string[] = Object.keys(PACKS).sort();

/** Default language used when the configured one is unknown. */
export const DEFAULT_LANGUAGE = "english";

/**
 * Resolve the language pack for the given name, falling back to
 * English with an `error`-level log when the name is not recognized.
 * Matches by exact lowercase name — typos do not silently mask as a
 * close language.
 */
export function resolveLanguagePack(name: string, log: Logger): LanguagePack {
    const normalized = name.toLowerCase().trim();
    const pack = PACKS[normalized];
    if (pack) {
        return pack;
    }
    log.error(
        {
            requested: name,
            supported: SUPPORTED_LANGUAGES.join(", "),
        },
        `memory: unknown language "${name}" — falling back to ${DEFAULT_LANGUAGE}`,
    );
    return PACKS[DEFAULT_LANGUAGE];
}
