/**
 * Deterministic generator for the large, noise-heavy corpus files of the memory eval set.
 *
 * Writes, for both corpus languages:
 * - `corpus/<lang>/wiki/threads/thermo-pi.md` — a ~150 KB project thread full of CI, release,
 *   Dependabot and duplicate-delivery noise, with five facts buried exactly once each.
 * - `corpus/<lang>/wiki/threads/whatsapp-gruppen-digest.md` (DE) /
 *   `whatsapp-group-digest.md` (EN) — a ~50 KB digest of trivial group chatter.
 *
 * Both languages are rendered from the same abstract entry model (same seed), so dates,
 * numbers and structure are parallel. Run from the repo root:
 *
 * ```
 * npx tsx plugins/memory/eval/GenerateNoise.ts
 * ```
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** A text in both corpus languages. */
interface Bilingual {
    readonly de: string;
    readonly en: string;
}

/** Seeded pseudo-random source shared by all generators. */
interface Random {
    /** Uniform float in [0, 1). */
    next(): number;
    /** Uniform integer in [min, max] (inclusive). */
    int(min: number, max: number): number;
    /** One element of a non-empty list. */
    pick<T>(items: readonly T[]): T;
}

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
    return {
        next,
        int: (min, max) => min + Math.floor(next() * (max - min + 1)),
        pick: (items) => items[Math.floor(next() * items.length)],
    };
}

/** Dates the generated noise must never use, because a buried fact owns them. */
const RESERVED_DATES = new Set(["2026-04-02", "2026-07-15"]);

/**
 * Draws a random ISO date between two ISO dates, skipping reserved dates.
 *
 * @param random - PRNG to draw from.
 * @param from - Earliest date, `YYYY-MM-DD`.
 * @param to - Latest date, `YYYY-MM-DD`.
 * @returns A `YYYY-MM-DD` date not in {@link RESERVED_DATES}.
 */
function randomDate(random: Random, from: string, to: string): string {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    for (;;) {
        const day = start + random.int(0, Math.floor((end - start) / 86_400_000)) * 86_400_000;
        const iso = new Date(day).toISOString().slice(0, 10);
        if (!RESERVED_DATES.has(iso)) {
            return iso;
        }
    }
}

/**
 * Draws a random `HH:MM` time of day.
 *
 * @param random - PRNG to draw from.
 * @returns A zero-padded time string.
 */
function randomTime(random: Random): string {
    return `${String(random.int(6, 23)).padStart(2, "0")}:${String(random.int(0, 59)).padStart(2, "0")}`;
}

/**
 * Draws a random lowercase hex string (commit SHAs, message-id fragments).
 *
 * @param random - PRNG to draw from.
 * @param length - Number of hex digits.
 * @returns The hex string.
 */
function randomHex(random: Random, length: number): string {
    let hex = "";
    for (let i = 0; i < length; i++) {
        hex += random.int(0, 15).toString(16);
    }
    return hex;
}

/** Versions the noise may mention — all 1.x and never the buried fix version 1.8.3. */
const NOISE_VERSIONS = [
    "1.4.0",
    "1.4.1",
    "1.5.0",
    "1.5.2",
    "1.6.0",
    "1.6.1",
    "1.7.0",
    "1.7.4",
    "1.8.0",
    "1.8.1",
    "1.8.2",
    "1.9.0",
    "1.9.1",
    "1.9.2",
] as const;

/** Fictional GitHub handles of occasional contributors (never the main contributor). */
const HANDLES = [
    "jw-kaltenbach",
    "heatmapper",
    "dev-otter",
    "pi-tinkerer",
    "radiator-rick",
    "nordlicht42",
    "kesselflicker",
    "thermostat-tina",
    "boiler-bob",
    "mqtt-mira",
] as const;

/** CI workflow job names. */
const CI_JOBS = [
    "build-armhf",
    "build-arm64",
    "unit-tests",
    "lint",
    "integration-mqtt",
    "docs-deploy",
    "image-build",
    "e2e-relay-sim",
] as const;

/** CI failure causes. */
const CI_CAUSES: readonly Bilingual[] = [
    {
        de: "Timeout beim Download des Raspberry-Pi-OS-Images",
        en: "timeout while downloading the Raspberry Pi OS image",
    },
    { de: "flakiger Test `test_pid_overshoot`", en: "flaky test `test_pid_overshoot`" },
    { de: "Runner ohne freien Speicherplatz", en: "runner out of disk space" },
    { de: "abgelaufenes Cache-Token", en: "expired cache token" },
    { de: "Rate-Limit der Container-Registry", en: "container registry rate limit" },
    { de: "fehlerhafte Formatierung nach Merge", en: "formatting drift after a merge" },
    {
        de: "MQTT-Broker im Testcontainer nicht rechtzeitig bereit",
        en: "MQTT broker in the test container not ready in time",
    },
];

/** Dependabot packages and their bump pairs. */
const DEPENDABOT_PACKAGES = [
    "paho-mqtt",
    "fastapi",
    "uvicorn",
    "pydantic",
    "gpiozero",
    "pytest",
    "ruff",
    "jinja2",
    "requests",
    "smbus2",
    "actions/checkout",
    "docker/build-push-action",
] as const;

/** Titles for noise issues (none of them about the relay clicking). */
const ISSUE_TITLES: readonly Bilingual[] = [
    { de: "Display zeigt nach Neustart 0 °C", en: "display shows 0 °C after reboot" },
    { de: "Zeitplan springt bei Sommerzeitumstellung", en: "schedule jumps at DST change" },
    { de: "Web-UI lädt auf Safari nicht", en: "web UI does not load on Safari" },
    {
        de: "Sensor DS18B20 liefert sporadisch 85 °C",
        en: "DS18B20 sensor sporadically reports 85 °C",
    },
    { de: "Absturz bei leerer Konfigurationsdatei", en: "crash on empty configuration file" },
    { de: "Übersetzung der Einstellungen unvollständig", en: "settings translation incomplete" },
    { de: "Logdatei wächst unbegrenzt", en: "log file grows without bound" },
    { de: "Frostschutzmodus greift zu spät", en: "frost protection kicks in too late" },
    { de: "Docker-Image zu groß", en: "Docker image too large" },
    {
        de: "PID-Regler schwingt bei Fußbodenheizung",
        en: "PID controller oscillates with underfloor heating",
    },
    { de: "Fehlende Doku zur Verkabelung", en: "missing wiring documentation" },
    { de: "API liefert falsche Zeitzone", en: "API returns the wrong time zone" },
];

/** Forum topics. */
const FORUM_TOPICS: readonly Bilingual[] = [
    {
        de: "Welcher Pi reicht für drei Heizkreise?",
        en: "Which Pi is enough for three heating circuits?",
    },
    {
        de: "Erfahrungen mit Thermo-Pi im Altbau",
        en: "Experiences with Thermo-Pi in an old building",
    },
    { de: "Gehäuse aus dem 3D-Drucker", en: "3D-printed enclosure" },
    { de: "Anbindung an Wärmepumpe möglich?", en: "Can it drive a heat pump?" },
    {
        de: "Stromverbrauch des Pi im Dauerbetrieb",
        en: "Power consumption of the Pi in continuous operation",
    },
    { de: "Thermo-Pi mit Solarthermie kombinieren", en: "Combining Thermo-Pi with solar thermal" },
];

/** Sections of the Thermo-Pi thread. `fact` marks the sections hosting a buried fact. */
const THERMO_SECTIONS: readonly {
    readonly title: Bilingual;
    readonly kinds: readonly EntryKind[];
    readonly fact?: FactId;
}[] = [
    {
        title: { de: "Überblick Benachrichtigungen", en: "Notification overview" },
        kinds: ["ciFail", "ciGreen", "release"],
    },
    {
        title: { de: "Releases 1.4.x", en: "Releases 1.4.x" },
        kinds: ["release", "nachtragRelease"],
    },
    { title: { de: "CI: Build-Pipeline", en: "CI: build pipeline" }, kinds: ["ciFail", "ciGreen"] },
    { title: { de: "Dependabot (Python)", en: "Dependabot (Python)" }, kinds: ["dependabot"] },
    {
        title: { de: "Issues: Sensorik", en: "Issues: sensors" },
        kinds: ["issueOpen", "issueClose"],
    },
    { title: { de: "Forum", en: "Forum" }, kinds: ["forum"] },
    {
        title: { de: "Releases 1.5.x", en: "Releases 1.5.x" },
        kinds: ["release", "nachtragRelease"],
    },
    {
        title: { de: "CI: Docs-Deployment", en: "CI: docs deployment" },
        kinds: ["ciFail", "ciGreen"],
    },
    { title: { de: "Issues: Web-UI", en: "Issues: web UI" }, kinds: ["issueOpen", "issueClose"] },
    {
        title: { de: "Dependabot (GitHub Actions)", en: "Dependabot (GitHub Actions)" },
        kinds: ["dependabot"],
    },
    {
        title: { de: "Hardware & Verkabelung", en: "Hardware & wiring" },
        kinds: ["hardware", "forum"],
    },
    {
        title: { de: "Releases 1.6.x", en: "Releases 1.6.x" },
        kinds: ["release", "nachtragRelease"],
    },
    {
        title: { de: "Issues: Relais & Aktorik", en: "Issues: relays & actuators" },
        kinds: ["issueOpen", "issueClose"],
        fact: "relay",
    },
    { title: { de: "Sponsoring & Spenden", en: "Sponsoring & donations" }, kinds: ["sponsor"] },
    { title: { de: "CI: Image-Build", en: "CI: image build" }, kinds: ["ciFail", "ciGreen"] },
    {
        title: { de: "Security-Hinweise", en: "Security advisories" },
        kinds: ["security", "dependabot"],
    },
    {
        title: { de: "Releases 1.7.x", en: "Releases 1.7.x" },
        kinds: ["release", "nachtragRelease"],
    },
    {
        title: { de: "Rechtliches & Lizenz", en: "Legal & license" },
        kinds: ["legal", "forum"],
        fact: "license",
    },
    { title: { de: "Dependabot (Docker)", en: "Dependabot (Docker)" }, kinds: ["dependabot"] },
    {
        title: { de: "Issues: Zeitpläne", en: "Issues: schedules" },
        kinds: ["issueOpen", "issueClose"],
    },
    {
        title: { de: "Beitragende", en: "Contributors" },
        kinds: ["contributor", "issueClose"],
        fact: "contributor",
    },
    {
        title: { de: "Releases 1.8.x", en: "Releases 1.8.x" },
        kinds: ["release", "nachtragRelease"],
    },
    {
        title: { de: "Integrationen", en: "Integrations" },
        kinds: ["integration", "forum"],
        fact: "homeAssistant",
    },
    {
        title: { de: "CI: Integrationstests", en: "CI: integration tests" },
        kinds: ["ciFail", "ciGreen"],
    },
    {
        title: { de: "Roadmap & Planung", en: "Roadmap & planning" },
        kinds: ["roadmap", "issueOpen"],
        fact: "release2",
    },
    {
        title: { de: "Issues: Installation", en: "Issues: installation" },
        kinds: ["issueOpen", "issueClose"],
    },
    {
        title: { de: "Releases 1.9.x", en: "Releases 1.9.x" },
        kinds: ["release", "nachtragRelease"],
    },
    { title: { de: "Dokumentation", en: "Documentation" }, kinds: ["docs", "ciGreen"] },
    { title: { de: "Forum: Support-Anfragen", en: "Forum: support requests" }, kinds: ["forum"] },
    {
        title: { de: "Sonstige Benachrichtigungen", en: "Other notifications" },
        kinds: ["ciFail", "dependabot", "sponsor"],
    },
];

/** Kinds of generated noise entries. */
type EntryKind =
    | "ciFail"
    | "ciGreen"
    | "release"
    | "nachtragRelease"
    | "dependabot"
    | "issueOpen"
    | "issueClose"
    | "forum"
    | "hardware"
    | "sponsor"
    | "security"
    | "legal"
    | "contributor"
    | "integration"
    | "roadmap"
    | "docs";

/** Identifiers of the buried facts. */
type FactId = "license" | "release2" | "contributor" | "relay" | "homeAssistant";

/** One dated bullet, renderable in both languages. */
interface Entry {
    readonly date: string;
    readonly render: Bilingual;
}

/**
 * The buried facts, each rendered exactly once in its host section. Dates are reserved or
 * chosen so the noise never repeats the distinctive tokens (GPL-3.0, MIT, 2026-07-15,
 * Sven Ostermann, svost, #142, 1.8.3, Leo Kramer).
 */
const FACTS: Record<FactId, Entry> = {
    license: {
        date: "2026-04-02",
        render: {
            de: "- **2026-04-02**: Lizenzwechsel umgesetzt — Thermo-Pi steht ab sofort nicht mehr unter **GPL-3.0**, sondern unter der **MIT**-Lizenz. Alle Beitragenden hatten im Issue zugestimmt; `LICENSE` und die Header der Quelldateien wurden in einem Commit ersetzt. Benachrichtigungsmail archiviert.",
            en: "- **2026-04-02**: License change done — Thermo-Pi is no longer licensed under **GPL-3.0** but under the **MIT** license. All contributors had agreed in the issue; `LICENSE` and the source file headers were replaced in one commit. Notification mail archived.",
        },
    },
    release2: {
        date: "2026-05-30",
        render: {
            de: "- **2026-05-30**: Meilenstein-Planung aktualisiert: Das große Release **2.0** (neue Regel-Engine, mehrere Heizkreise) ist jetzt für den **2026-07-15** geplant. Jürgen hat den Milestone-Termin im Tracker angepasst; Mail archiviert.",
            en: "- **2026-05-30**: Milestone planning updated: the big release **2.0** (new control engine, multiple heating circuits) is now planned for **2026-07-15**. Jürgen moved the milestone date in the tracker; mail archived.",
        },
    },
    contributor: {
        date: "2026-02-17",
        render: {
            de: "- **2026-02-17**: Laut Contributor-Statistik ist **Sven Ostermann** (`svost`) inzwischen der Hauptbeitragende — mehr Commits als Jürgen selbst, vor allem Regel-Engine und Tests. Jürgen hat ihm Maintainer-Rechte gegeben. Benachrichtigung archiviert.",
            en: "- **2026-02-17**: According to the contributor statistics, **Sven Ostermann** (`svost`) is now the main contributor — more commits than Jürgen himself, mostly control engine and tests. Jürgen granted him maintainer rights. Notification archived.",
        },
    },
    relay: {
        date: "2026-01-21",
        render: {
            de: "- **2026-01-21**: Issue **#142** „Relais klackt alle 30 Sekunden“ geschlossen — Ursache war eine fehlende Hysterese im Schaltzyklus; behoben in Version **1.8.3**. Mail archiviert, im Digest vermerkt.",
            en: '- **2026-01-21**: Issue **#142** "relay clicks every 30 seconds" closed — the cause was a missing hysteresis in the switching cycle; fixed in version **1.8.3**. Mail archived, noted in the digest.',
        },
    },
    homeAssistant: {
        date: "2026-03-09",
        render: {
            de: "- **2026-03-09**: Pull Request von **Leo Kramer** gemerged: native **Home-Assistant-Integration** (Auto-Discovery per MQTT, Klima-Entität pro Heizkreis). Jürgen hat sich im PR ausdrücklich bedankt; Benachrichtigung archiviert.",
            en: "- **2026-03-09**: Pull request by **Leo Kramer** merged: native **Home Assistant integration** (auto-discovery via MQTT, one climate entity per heating circuit). Jürgen thanked him explicitly in the PR; notification archived.",
        },
    },
};

/**
 * Draws a noise issue number that never collides with the buried issue #142.
 *
 * @param random - PRNG to draw from.
 * @returns An issue number in 150–480.
 */
function noiseIssueNumber(random: Random): number {
    return random.int(150, 480);
}

/**
 * Builds the optional duplicate-delivery addendum ("Nachtrag") appended to some entries.
 *
 * @param random - PRNG to draw from.
 * @param date - Date of the original entry; the replay happens later.
 * @returns The addendum in both languages, or empty strings.
 */
function maybeNachtrag(random: Random, date: string): Bilingual {
    if (random.next() > 0.35) {
        return { de: "", en: "" };
    }
    const replayDate = randomDate(random, date, "2026-10-31");
    const time = randomTime(random);
    const id = randomHex(random, 12);
    return {
        de: ` **Nachtrag (${replayDate}, ${time}):** Dieselbe Benachrichtigung (identische \`Message-ID\` …${id}@github.com) wurde erneut zugestellt — Doppelzustellung/Replay, inhaltlich nichts Neues, Mail erneut archiviert, keine Aktion.`,
        en: ` **Addendum (${replayDate}, ${time}):** The same notification (identical \`Message-ID\` …${id}@github.com) was delivered again — duplicate delivery/replay, nothing new, mail archived again, no action.`,
    };
}

/**
 * Generates one noise entry of the given kind.
 *
 * @param random - PRNG to draw from.
 * @param kind - Entry kind, chosen by the host section.
 * @returns The dated entry in both languages.
 */
function noiseEntry(random: Random, kind: EntryKind): Entry {
    const date = randomDate(random, "2025-09-01", "2026-10-31");
    const handle = random.pick(HANDLES);
    const sha = randomHex(random, 7);
    const version = random.pick(NOISE_VERSIONS);
    const addendum = maybeNachtrag(random, date);
    const join = (de: string, en: string): Bilingual => ({
        de: `- **${date}**: ${de}${addendum.de}`,
        en: `- **${date}**: ${en}${addendum.en}`,
    });
    switch (kind) {
        case "ciFail": {
            const job = random.pick(CI_JOBS);
            const cause = random.pick(CI_CAUSES);
            return {
                date,
                render: join(
                    `GitHub Actions meldet fehlgeschlagenen Workflow **${job}** auf \`main\` (Commit \`${sha}\`) — Ursache: ${cause.de}. Mail archiviert, kein Handlungsbedarf.`,
                    `GitHub Actions reports failed workflow **${job}** on \`main\` (commit \`${sha}\`) — cause: ${cause.en}. Mail archived, no action needed.`,
                ),
            };
        }
        case "ciGreen": {
            const job = random.pick(CI_JOBS);
            return {
                date,
                render: join(
                    `Workflow **${job}** wieder grün nach Re-Run (Commit \`${sha}\`, Laufzeit ${random.int(3, 28)} min). Reine Statusmeldung, Mail archiviert.`,
                    `Workflow **${job}** green again after re-run (commit \`${sha}\`, runtime ${random.int(3, 28)} min). Status message only, mail archived.`,
                ),
            };
        }
        case "release":
            return {
                date,
                render: join(
                    `GitHub-Release **v${version}** veröffentlicht (${random.int(3, 14)} Changelog-Einträge, ${random.int(40, 900)} Downloads in der ersten Woche). Release-Mail an die Watcher verschickt, Kopie archiviert.`,
                    `GitHub release **v${version}** published (${random.int(3, 14)} changelog entries, ${random.int(40, 900)} downloads in the first week). Release mail sent to watchers, copy archived.`,
                ),
            };
        case "nachtragRelease":
            return {
                date,
                render: join(
                    `Docker-Image \`thermo-pi:${version}\` für armhf und arm64 in die Registry gepusht (Digest \`sha256:${randomHex(random, 12)}…\`). Automatische Mail, archiviert.`,
                    `Docker image \`thermo-pi:${version}\` for armhf and arm64 pushed to the registry (digest \`sha256:${randomHex(random, 12)}…\`). Automatic mail, archived.`,
                ),
            };
        case "dependabot": {
            const pkg = random.pick(DEPENDABOT_PACKAGES);
            const major = random.int(0, 6);
            const minor = random.int(0, 30);
            return {
                date,
                render: join(
                    `Dependabot-PR **#${noiseIssueNumber(random)}**: \`${pkg}\` ${major}.${minor}.${random.int(0, 9)} → ${major}.${minor + 1}.0; CI grün, gemerged von \`${handle}\`. Benachrichtigung archiviert.`,
                    `Dependabot PR **#${noiseIssueNumber(random)}**: \`${pkg}\` ${major}.${minor}.${random.int(0, 9)} → ${major}.${minor + 1}.0; CI green, merged by \`${handle}\`. Notification archived.`,
                ),
            };
        }
        case "issueOpen": {
            const title = random.pick(ISSUE_TITLES);
            return {
                date,
                render: join(
                    `Neues Issue **#${noiseIssueNumber(random)}** „${title.de}“ von \`${handle}\` (Version ${version}). Label \`needs-triage\` gesetzt, Mail archiviert.`,
                    `New issue **#${noiseIssueNumber(random)}** "${title.en}" by \`${handle}\` (version ${version}). Label \`needs-triage\` added, mail archived.`,
                ),
            };
        }
        case "issueClose": {
            const title = random.pick(ISSUE_TITLES);
            return {
                date,
                render: join(
                    `Issue **#${noiseIssueNumber(random)}** „${title.de}“ geschlossen (Commit \`${sha}\`). Reine Statusmeldung, im Digest vermerkt.`,
                    `Issue **#${noiseIssueNumber(random)}** "${title.en}" closed (commit \`${sha}\`). Status message only, noted in the digest.`,
                ),
            };
        }
        case "forum": {
            const topic = random.pick(FORUM_TOPICS);
            return {
                date,
                render: join(
                    `Forum-Beitrag „${topic.de}“ von \`${handle}\` (${random.int(1, 19)} Antworten). Jürgen hat kurz geantwortet bzw. auf die Doku verwiesen; Benachrichtigung archiviert.`,
                    `Forum post "${topic.en}" by \`${handle}\` (${random.int(1, 19)} replies). Jürgen answered briefly or pointed to the docs; notification archived.`,
                ),
            };
        }
        case "hardware":
            return {
                date,
                render: join(
                    `Testaufbau erweitert: ${random.pick(["zweiter DS18B20-Sensor", "Relais-Board mit 4 Kanälen", "Pi 4 mit 2 GB", "Stellantrieb 24 V", "I²C-Display 0,96″"])} am Prüfstand angeschlossen, Messwerte ${random.int(2, 9)} Tage lang mitgeloggt.`,
                    `Test rig extended: ${random.pick(["second DS18B20 sensor", "4-channel relay board", "Pi 4 with 2 GB", "24 V valve actuator", "0.96″ I²C display"])} connected to the bench, readings logged for ${random.int(2, 9)} days.`,
                ),
            };
        case "sponsor":
            return {
                date,
                render: join(
                    `GitHub Sponsors: neue monatliche Unterstützung über ${random.int(2, 15)} $ von \`${handle}\`. Danke-Mail automatisch verschickt, Benachrichtigung archiviert.`,
                    `GitHub Sponsors: new monthly support of $${random.int(2, 15)} from \`${handle}\`. Thank-you mail sent automatically, notification archived.`,
                ),
            };
        case "security":
            return {
                date,
                render: join(
                    `Security-Advisory für eine transitive Abhängigkeit (Schweregrad ${random.pick(["niedrig", "mittel"])}); Thermo-Pi nicht betroffen, Alert geschlossen. Mail archiviert.`,
                    `Security advisory for a transitive dependency (severity ${random.pick(["low", "moderate"])}); Thermo-Pi not affected, alert dismissed. Mail archived.`,
                ),
            };
        case "legal":
            return {
                date,
                render: join(
                    `Anfrage von \`${handle}\`, ob Thermo-Pi in einem kommerziellen Heizungsprodukt eingesetzt werden darf. Jürgen hat auf die \`LICENSE\`-Datei verwiesen; Mail archiviert.`,
                    `Question from \`${handle}\` whether Thermo-Pi may be used in a commercial heating product. Jürgen pointed to the \`LICENSE\` file; mail archived.`,
                ),
            };
        case "contributor":
            return {
                date,
                render: join(
                    `Erster PR von \`${handle}\` gemerged (${random.pick(["Tippfehler in der Doku", "Übersetzung", "Testfall", "Beispielkonfiguration"])}). Willkommens-Kommentar gepostet, Mail archiviert.`,
                    `First PR by \`${handle}\` merged (${random.pick(["docs typo", "translation", "test case", "example configuration"])}). Welcome comment posted, mail archived.`,
                ),
            };
        case "integration":
            return {
                date,
                render: join(
                    `Diskussion zur Anbindung an ${random.pick(["Node-RED", "openHAB", "ioBroker", "Grafana", "InfluxDB"])} von \`${handle}\` eröffnet; noch keine Entscheidung. Benachrichtigung archiviert.`,
                    `Discussion about connecting ${random.pick(["Node-RED", "openHAB", "ioBroker", "Grafana", "InfluxDB"])} opened by \`${handle}\`; no decision yet. Notification archived.`,
                ),
            };
        case "roadmap":
            return {
                date,
                render: join(
                    `Projekt-Board aufgeräumt: ${random.int(3, 12)} Karten von „Ideen“ nach „Später“ verschoben. Automatische Mail, archiviert.`,
                    `Project board tidied: ${random.int(3, 12)} cards moved from "Ideas" to "Later". Automatic mail, archived.`,
                ),
            };
        case "docs":
            return {
                date,
                render: join(
                    `Doku-Seite „${random.pick(["Installation", "Verkabelung", "Konfiguration", "FAQ", "Fehlersuche"])}“ überarbeitet (Commit \`${sha}\`), Docs-Deployment erfolgreich.`,
                    `Docs page "${random.pick(["Installation", "Wiring", "Configuration", "FAQ", "Troubleshooting"])}" revised (commit \`${sha}\`), docs deployment succeeded.`,
                ),
            };
    }
}

/**
 * Builds the Thermo-Pi thread in both languages.
 *
 * @param entriesPerSection - Noise entries per section; tunes the file size.
 * @returns Markdown per language.
 */
function buildThermoPi(entriesPerSection: number): Bilingual {
    const random = createRandom(0x7e4a0);
    const parts: { de: string[]; en: string[] } = {
        de: [
            "# Thermo-Pi",
            "",
            "Jürgens Open-Source-Heizungssteuerung für den Raspberry Pi (GitHub-Repository `juergenweiss/thermo-pi`): Regelung mehrerer Heizkörper über Relais und Temperatursensoren, Web-UI und MQTT. Hier landen alle Benachrichtigungen zum Projekt — Releases, CI, Issues, Forum.",
        ],
        en: [
            "# Thermo-Pi",
            "",
            "Jürgen's open-source heating controller for the Raspberry Pi (GitHub repository `juergenweiss/thermo-pi`): controls several radiators via relays and temperature sensors, with a web UI and MQTT. All notifications about the project end up here — releases, CI, issues, forum.",
        ],
    };
    for (const section of THERMO_SECTIONS) {
        const entries: Entry[] = [];
        for (let i = 0; i < entriesPerSection; i++) {
            entries.push(noiseEntry(random, random.pick(section.kinds)));
        }
        entries.sort((a, b) => a.date.localeCompare(b.date));
        if (section.fact) {
            // Bury the fact in the middle of the section, surrounded by noise.
            entries.splice(Math.floor(entries.length / 2), 0, FACTS[section.fact]);
        }
        for (const lang of ["de", "en"] as const) {
            parts[lang].push(
                "",
                `## ${section.title[lang]}`,
                "",
                ...entries.map((entry) => entry.render[lang]),
            );
        }
    }
    return { de: `${parts.de.join("\n")}\n`, en: `${parts.en.join("\n")}\n` };
}

/** One WhatsApp group with its localized name and chatter lines. */
interface ChatGroup {
    readonly name: Bilingual;
    readonly lines: readonly Bilingual[];
}

/** The WhatsApp groups and their trivial chatter. */
const CHAT_GROUPS: readonly ChatGroup[] = [
    {
        name: { de: "Mühlbach-Bande", en: "Muehlbach Gang" },
        lines: [
            {
                de: "Björn teilt ein Foto vom alten Schulhof, alle schwelgen in Erinnerungen",
                en: "Björn shares a photo of the old schoolyard, everyone reminisces",
            },
            {
                de: "Henrik fragt, wer am Samstag zum Grillen kommt; vier Zusagen",
                en: "Henrik asks who is coming to the barbecue on Saturday; four yes",
            },
            {
                de: "Diskussion über das letzte Fußballspiel, keine Einigung",
                en: "discussion about the last football match, no agreement",
            },
            {
                de: "Björn schickt ein Meme über Montage, Jürgen reagiert mit 😂",
                en: "Björn sends a meme about Mondays, Jürgen reacts with 😂",
            },
            {
                de: "Terminabstimmung fürs nächste Treffen, Ergebnis offen",
                en: "scheduling the next get-together, still open",
            },
            {
                de: "Henrik empfiehlt eine Serie, zwei haben sie schon gesehen",
                en: "Henrik recommends a series, two have already watched it",
            },
            {
                de: "Geburtstagsglückwünsche in der Runde, viele Emojis",
                en: "birthday wishes in the group, lots of emojis",
            },
        ],
    },
    {
        name: { de: "Elternrat 4b", en: "Parents 4b" },
        lines: [
            {
                de: "Erinnerung: Brotdosen beschriften, Fundkiste läuft über",
                en: "reminder: label lunch boxes, the lost-and-found box is overflowing",
            },
            {
                de: "Katrin fragt nach Helfern für das Schulfest-Kuchenbuffet",
                en: "Katrin asks for volunteers for the school fair cake buffet",
            },
            {
                de: "Läuse-Hinweis aus der Parallelklasse, bitte Köpfe kontrollieren",
                en: "head lice notice from the parallel class, please check",
            },
            { de: "Wandertag verschoben wegen Regen", en: "hiking day postponed because of rain" },
            {
                de: "Sammlung für das Abschiedsgeschenk der Referendarin, 5 € pro Kind",
                en: "collection for the trainee teacher's farewell gift, 5 € per child",
            },
            {
                de: "Frage, ob morgen Sportunterricht draußen stattfindet",
                en: "question whether PE is outside tomorrow",
            },
            {
                de: "Elternabend-Protokoll als PDF geteilt",
                en: "parents' evening minutes shared as PDF",
            },
        ],
    },
    {
        name: { de: "Handball U16", en: "Handball U16" },
        lines: [
            {
                de: "Trainingszeit am Mittwoch fällt aus, Halle belegt",
                en: "Wednesday practice cancelled, gym booked",
            },
            {
                de: "Fahrgemeinschaft zum Auswärtsspiel gesucht, Jürgen bietet zwei Plätze an",
                en: "carpool for the away game wanted, Jürgen offers two seats",
            },
            {
                de: "Ergebnis vom Wochenende: knapper Sieg, Fritzi mit drei Toren",
                en: "weekend result: narrow win, Fritzi scored three goals",
            },
            {
                de: "Trikots bitte gewaschen zum nächsten Spiel mitbringen",
                en: "please bring washed jerseys to the next game",
            },
            {
                de: "Trainerin teilt den Hallenplan für den Monat",
                en: "coach shares the gym schedule for the month",
            },
            {
                de: "Abstimmung über die Weihnachtsfeier der Mannschaft",
                en: "vote on the team's Christmas party",
            },
        ],
    },
    {
        name: { de: "Ahornweg 7 Nachbarn", en: "Ahornweg 7 neighbours" },
        lines: [
            {
                de: "Paket für Wohnung 4 bei Henrik abgegeben",
                en: "parcel for flat 4 left with Henrik",
            },
            {
                de: "Hinweis: Mülltonnen werden morgen früh geleert",
                en: "note: bins are emptied tomorrow morning",
            },
            {
                de: "Haustür schließt schlecht, Hausverwaltung Lenz ist informiert",
                en: "front door doesn't close properly, Hausverwaltung Lenz informed",
            },
            {
                de: "Wer hat den Kinderwagen im Flur stehen lassen?",
                en: "who left the pram in the hallway?",
            },
            {
                de: "Treppenhausreinigung diese Woche durch Wohnung 2",
                en: "stairwell cleaning this week by flat 2",
            },
            {
                de: "Wasserabstellung am Donnerstag 9–11 Uhr angekündigt",
                en: "water shut-off announced for Thursday 9–11",
            },
        ],
    },
];

/**
 * Builds the WhatsApp digest thread in both languages, one `##` section per month.
 *
 * @param entriesPerMonth - Digest bullets per month; tunes the file size.
 * @returns Markdown per language.
 */
function buildWhatsappDigest(entriesPerMonth: number): Bilingual {
    const random = createRandom(0x5a17);
    const parts: { de: string[]; en: string[] } = {
        de: [
            "# WhatsApp-Gruppen-Digest",
            "",
            "Tägliche Kurzzusammenfassungen der WhatsApp-Gruppen, in denen Jürgen Mitglied ist (Mühlbach-Bande, Elternrat 4b, Handball U16, Ahornweg 7 Nachbarn). Nur Überblick, keine Handlungspunkte.",
        ],
        en: [
            "# WhatsApp group digest",
            "",
            "Daily short summaries of the WhatsApp groups Jürgen is a member of (Muehlbach Gang, Parents 4b, Handball U16, Ahornweg 7 neighbours). Overview only, no action items.",
        ],
    };
    const months = [
        "2025-11",
        "2025-12",
        "2026-01",
        "2026-02",
        "2026-03",
        "2026-04",
        "2026-05",
        "2026-06",
        "2026-07",
        "2026-08",
        "2026-09",
        "2026-10",
    ];
    for (const month of months) {
        const entries: { date: string; render: Bilingual }[] = [];
        for (let i = 0; i < entriesPerMonth; i++) {
            const day = String(random.int(1, 28)).padStart(2, "0");
            const date = `${month}-${day}`;
            const group = random.pick(CHAT_GROUPS);
            const line = random.pick(group.lines);
            const count = random.int(3, 60);
            entries.push({
                date,
                render: {
                    de: `- **${date} · ${group.name.de}** (${count} Nachrichten): ${line.de}.`,
                    en: `- **${date} · ${group.name.en}** (${count} messages): ${line.en}.`,
                },
            });
        }
        entries.sort((a, b) => a.date.localeCompare(b.date));
        for (const lang of ["de", "en"] as const) {
            parts[lang].push("", `## ${month}`, "", ...entries.map((entry) => entry.render[lang]));
        }
    }
    return { de: `${parts.de.join("\n")}\n`, en: `${parts.en.join("\n")}\n` };
}

/**
 * Writes one generated file, creating parent folders.
 *
 * @param filePath - Absolute target path.
 * @param content - File content.
 */
function writeCorpusFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    console.log(
        `wrote ${path.relative(process.cwd(), filePath)} (${Buffer.byteLength(content)} bytes)`,
    );
}

/** Entry point: generate every noise file for both languages. */
function main(): void {
    const evalDir = path.dirname(new URL(import.meta.url).pathname);
    const thermoPi = buildThermoPi(22);
    const digest = buildWhatsappDigest(40);
    writeCorpusFile(path.join(evalDir, "corpus/de/wiki/threads/thermo-pi.md"), thermoPi.de);
    writeCorpusFile(path.join(evalDir, "corpus/en/wiki/threads/thermo-pi.md"), thermoPi.en);
    writeCorpusFile(
        path.join(evalDir, "corpus/de/wiki/threads/whatsapp-gruppen-digest.md"),
        digest.de,
    );
    writeCorpusFile(
        path.join(evalDir, "corpus/en/wiki/threads/whatsapp-group-digest.md"),
        digest.en,
    );
}

main();
