# Eval persona: the fictional world

Every file in `corpus/de/` and `corpus/en/` describes this world. It is entirely fictional and was designed to reproduce problem patterns observed in a real assistant wiki (see `README.md` → "Origins"), never its content. Keep it consistent: when you add a file or a case, check the facts here first and extend this file when you invent new ones.

The corpus "now" is **2026-11-01**. Nothing in the corpus happens after that date.

## The user

**Jürgen Weiß** (48), freelance software consultant, lives at **Ahornweg 7, 35791 Kaltenbach** (fictional small town). Email `juergen@example.com`. The umlaut and the ß are deliberate: slugs transliterate them (`juergen-weiss`), queries may not.

- Partner **Ines Weiß** (46), physiotherapist. Got a new **left knee** (knee replacement, "Knie-TEP") on 2026-06-09 at Klinikum Kaltenbach, then **inpatient rehab 2026-06-16 – 2026-07-07** at "Rehaklinik Sonnenhang" in Bad Lauterbrunn.
- Son **Paul Weiß** (10), 4th grade at Grundschule am Mühlbach. Best friend **Jannis Brandt** (often misspelled "Janis"). Mobile tariff "FunkFix Kids S" for **6,99 €/month**, contract since 2026-02-01.
- Daughter **Friederike Weiß**, called **"Fritzi"** (14), Gymnasium Kaltenbach, 9th grade. Plays handball.
- Grandmother **Gisela Weiß** ("Oma Gisela"), died **2024-11-18** at 94. Left Jürgen the house **"Alte Mühle"** (see below).
- Aunts **Hedi Kranz** ("Tante Hedi") and **Roswitha Pfaff** ("Tante Roswitha"), sisters of Jürgen's late father. Usually visit *together* ("die Tanten"), every spring and before Christmas.

## Places

- **Ahornweg 7, Kaltenbach** — the family home, a flat in a 6-unit building; Jürgen is co-owner → owners' association (WEG) **Ahornweg 7**, administrator **Hausverwaltung Lenz**.
- **Lindenstraße 3, Kaltenbach** — a rented-out flat Jürgen owns → second owners' association (WEG) **Lindenstraße 3**, administrator **Immobilien Vogt**. Deliberately confusable with Ahornweg 7. Often written "Lindenstr. 3".
- **Alte Mühle**, Mühlweg 2, 35796 Unterbrunn — the inherited house of Oma Gisela. A renovation was *considered* (estimate 2025-03: ~280,000 €) but **rejected** on 2025-04-10 before anything started. Sale via broker **Ralf Szymanski** (Szymanski Immobilien): listed 2025-06, no suitable buyer, broker contract ended 2026-01-31; sale paused. The word "Immobilie" / "Haus verkaufen" appears only in the body — the file name never says "house" or "property". Typo trap: "Altemühle", inflected "der Alten Mühle".
- **Praxis Dr. Anna Reuter**, Bahnhofstraße 12, Kaltenbach — family doctor (Hausärztin).
- **Gasthaus Zum Schwan**, Marktplatz 4, Kaltenbach — where the developer meetup meets.
- **Jugendherberge Burg Falkenstein** — venue of the meetup's planned hackathon weekend 2027-03-12 – 2027-03-14.

## People files (`wiki/people/`)

Slugs are identical in both languages except family/relatives (localized prefixes).

| DE slug | EN slug | Who | Notes / traps |
|---|---|---|---|
| `juergen-weiss` | `juergen-weiss` | the user | short file, links everywhere |
| `ines-weiss` | `ines-weiss` | partner | knee, rehab, physiotherapist, likes tulips |
| `ines` | `ines` | **duplicate** of Ines, older, 6 lines | duplicate trap |
| `paul-weiss` | `paul-weiss` | son | Jannis, tariff, school |
| `friederike-weiss` | `friederike-weiss` | daughter "Fritzi" | nickname trap: body says "Fritzi" much more often than Friederike |
| `oma-gisela` | `grandma-gisela` | grandmother | inheritance, Alte Mühle |
| `tante-hedi` | `aunt-hedi` | aunt | visits with Roswitha |
| `tante-roswitha` | `aunt-roswitha` | aunt | visits with Hedi |
| `jannis-brandt` | `jannis-brandt` | Paul's friend | spelled "Janis" in two places |
| `katrin-brandt` | `katrin-brandt` | Jannis' mother | organizes summer holiday care; owns the dog **Leo** |
| `tobias-hartl` | `tobias-hartl` | board game group, IT admin at a hospital | confusable with Harter |
| `tobias-harter` | `tobias-harter` | tax advisor at **KRW Partner Steuerberatung** | confusable with Hartl |
| `bjoern-groessler` | `bjoern-groessler` | **Björn Größler**, board game group + Mühlbach-Bande, lives in Lauterbrunn | umlaut/ß trap: queries "Größler", "Grössler", "Groessler" |
| `henrik-sommer` | `henrik-sommer` | neighbour (Ahornweg 7, 2nd floor), Mühlbach-Bande | |
| `henrik` | `henrik` | **duplicate** of Henrik Sommer, 5 lines | duplicate trap |
| `sven-ostermann` | `sven-ostermann` | main contributor of Thermo-Pi, GitHub handle `svost` | |
| `mara-lindqvist` | `mara-lindqvist` | project lead at Brightwater GmbH | |
| `dirk-pohlmann` | `dirk-pohlmann` | CTO at Brightwater GmbH | |
| `selin-aydin` | `selin-aydin` | purchasing at Brightwater GmbH | |
| `anna-reuter` | `anna-reuter` | family doctor, Bahnhofstraße 12 | |
| `wolfram-ziegenbalg` | `wolfram-ziegenbalg` | insurance broker (Ziegenbalg Finanz) | rare surname |
| `helga-bruennich` | `helga-bruennich` | notary **Dr. Helga Brünnich** | umlaut trap |
| `ralf-szymanski` | `ralf-szymanski` | real-estate broker for the Alte Mühle | |
| `nele-hoffmann` | `nele-hoffmann` | organizer of the founders' meetup | |
| `kai-wendt` | `kai-wendt` | founder of the startup **Lumora** (smart glasses for warehouse picking), pitched at the founders' meetup | semantic trap: "vision", "Weitblick", "Durchblick" |
| `yusuf-demir` | `yusuf-demir` | organizer of the developer meetup, side project **PlantWatch** | |
| `lisa-tran` | `lisa-tran` | developer meetup, side project **Brotzeit** (sourdough timer app) | |
| `familie-nowak` | `family-nowak` | family friends, share the Norway cabin 2027 | family prefix localized |

**Leo** has no file. The name appears casually in exactly three files: Katrin's dog Leo (`katrin-brandt`), contributor Leo Kramer in `thermo-pi`, and Fritzi's classmate Leo in `journal/2026-06`.

**Tom** appears nowhere. **Studio Nord** appears nowhere. No file mentions tablets, e-ink, sailing.

## Thread files (`wiki/threads/`)

| DE slug | EN slug | Content |
|---|---|---|
| `thermo-pi` | `thermo-pi` | **giant file, generated** (`GenerateNoise.ts`). Jürgen's open-source heating controller for the Raspberry Pi. Buried facts: license changed **GPL-3.0 → MIT on 2026-04-02**; **release 2.0 planned for 2026-07-15**; main contributor **Sven Ostermann**; issue **#142 "relay clicks every 30 s"** fixed in 1.8.3; contributor Leo Kramer added Home Assistant integration. Noise: CI failure mails, release notifications, Dependabot PRs, duplicate deliveries ("Nachtrag: same notification delivered again"). |
| `brettspielabend` | `board-game-night` | Monthly board game group (Jürgen, Tobias Hartl, Björn Größler, Henrik Sommer, Yusuf Demir), favourite game **"Sternenimperium"** ("Star Empire"). Typo trap: "Sternenimperrium". |
| `muehlbach-bande` | `muehlbach-gang` | Nickname of a WhatsApp group of old school friends (Jürgen, Björn, Henrik, two others). The thread file is about the group; the nickname "Mühlbach-Bande" ≠ any person's name. Overlaps with board game group members. |
| `entwickler-stammtisch` | `developer-meetup` | **Side-Project-Stammtisch ("SPS")** / EN **"Side Project Meetup (SPM)"**: developers with own projects (Thermo-Pi, PlantWatch, Brotzeit) meet every 2nd Thursday at Gasthaus Zum Schwan. Planned hackathon weekend 2027-03-12 – 14 at Jugendherberge Burg Falkenstein; booking discussed with the youth hostel 2026-10. Abbreviation trap: queries use only "SPS"/"SPM". |
| `ferienhaus-norwegen-2027` | `norway-cabin-2027` | Cabin near Ålesund, 2027-07-24 – 2027-08-07, with Familie Nowak and Henrik Sommer's family; deposit paid 2026-10-05. |
| `alte-muehle` | `alte-muehle` | the inherited house — see Places. Body uses "Immobilie", "Haus", "Verkauf", "Makler"; never in title. |
| `erbschein-grundbuch` | `inheritance-land-registry` | Certificate of inheritance (Erbschein) via notary Dr. Helga Brünnich (2025-01), land-registry correction (Grundbuchberichtigung) at Amtsgericht Unterbrunn completed 2025-02-20. |
| `weg-ahornweg-7` | `hoa-ahornweg-7` | Owners' association of the home. Annual meeting 2026-06-18, roof repair levy 4,200 € share. |
| `weg-lindenstrasse-3` | `hoa-lindenstrasse-3` | Owners' association of the rented flat. Tenant change 2026-09, heating replacement decided 2026-05-12. Confusable with Ahornweg 7. |
| `jahresabschluss-2025` | `annual-accounts-2025` | Annual accounts 2025 with **KRW Partner Steuerberatung**, advisor **Tobias Harter**. Review meeting **2026-05-25** (never 14 March). Documents sent 2026-04-28. |
| `nordbank-pushtan-vorfall` | `nordbank-pushtan-incident` | 2026-08-03: unexpected pushTAN prompt for "new device" at Nordbank (fictional bank); Jürgen didn't confirm, called hotline, device unlinked, password changed. |
| `kfz-versicherung` | `car-insurance` | Insurance for both cars (see `fahrzeuge`), switched Mazda to "Hanse Direkt" 2026-01. |
| `berufsunfaehigkeit-antrag` | `disability-insurance-application` | Application for disability insurance via broker Wolfram Ziegenbalg, health questions, application submitted 2026-09-15, accepted with exclusion 2026-10-20. |
| `mobilfunk` | `mobile-contracts` | Family mobile contracts at **FunkFix**; Paul's "Kids S" 6,99 €; Fritzi's tariff 12,99 €; invoices monthly. |
| `optiker-brillen` | `optician-glasses` | Optician "Optik Klarblick", Jürgen's new varifocals 2026-03, Fritzi's contact lenses trial 2026-09. No eye surgery anywhere. |
| `ines-reha-knie` | `ines-knee-rehab` | Ines' knee replacement and rehab (dates above), physiotherapy after, sick leave until 2026-08-31. |
| `paket-kopfhoerer` | `package-headphones` | **throwaway**: headphones order, tracking no., three delivery notifications. |
| `paket-druckerpatronen` | `package-ink-cartridges` | **throwaway**: same pattern. |
| `paket-gartenschlauch` | `package-garden-hose` | **throwaway**: same pattern. |
| `retech-diensthandy` | `retech-work-phone` | Refurbished work phone (Pixel) bought at **ReTech** (fictional), setup incl. Google Pay cards, 2026-09-22. |
| `brightwater-projekt` | `brightwater-project` | Consulting client Brightwater GmbH: data platform migration, Mara Lindqvist / Dirk Pohlmann / Selin Aydin, purchase order 2026-08, kickoff 2026-09-01. |
| `gruenderstammtisch-kaltenbach` | `kaltenbach-founders-meetup` | Founders' meetup organized by Nele Hoffmann; pitches incl. Kai Wendt / Lumora. Uses "Vision", "Weitblick" in the pitch sense (semantic trap for eye queries). |
| `dealflow` | `dealflow` | Jürgen as small angel investor: Lumora (passed), two others. Keyword-salad target. |
| `fahrzeuge` | `vehicles` | Family has **two cars**: **Mazda6 Kombi** (estate, 2019, Jürgen) and **Hyundai i10** (small car, 2021, mostly Ines). Long history: services, tyre changes (last: **both cars 2026-10-24**, winter tyres), TÜV, a parking dent. Buried state facts. |
| `ferienbetreuung-sommer-2026` | `summer-holiday-care-2026` | Holiday care for Paul, organized with Katrin Brandt, weeks 2026-07-20 – 2026-08-07. |
| `whatsapp-gruppen-digest` | `whatsapp-group-digest` | **large, generated** noise: daily digests of several WhatsApp groups. |
| `phishing-muster` | `phishing-patterns` | Phishing mails seen (fake parcel, fake bank, fake invoice) — generic vocabulary ("Termin", "Frist", "Konto", "dringend") that matches many vague queries. |

## Self (`wiki/self/`)

| DE | EN | Content |
|---|---|---|
| `routinen` | `routines` | gym Tue/Thu 07:00, Sunday long run, Friday pizza |
| `essen` | `food` | likes Thai food, dislikes coriander, coffee black |
| `timeline` | `timeline` | life events (moved to Kaltenbach 2012, freelance 2018, Oma Gisela died 2024-11-18, …) |
| `newsletters` | `newsletters` | long list of newsletter senders and handling — broad noise |
| `dienste` | `services` | long list of accounts/subscriptions (FunkFix, Nordbank, streaming, …) — broad noise |

## Places (`wiki/places/`)

| DE | EN |
|---|---|
| `praxis-dr-reuter` | `practice-dr-reuter` |
| `gasthaus-zum-schwan` | `zum-schwan-inn` |
| `jugendherberge-burg-falkenstein` | `burg-falkenstein-youth-hostel` |
| `ahornweg-7` | `ahornweg-7` |

## Journal (`wiki/journal/`)

`2026-05.md`, `2026-06.md` (same names in both languages), one `##` per entry, `## YYYY-MM-DD: title`. Include 2026-05-14 (first swim in the lake), 2026-05-25 (tax meeting, also in thread), 2026-06-09 (Ines' surgery), 2026-06-20 (Fritzi handball tournament, classmate Leo).

## Distractors outside the wiki

Identical in both languages unless the content is prose (then translated):

- `chat/telegram.md`, `mail/index.md` — handler files with frontmatter (`description:`), English agent instructions in both corpora (as in real workspaces).
- `files/mail/rules/@funkfix.example.md`, `files/mail/rules/@retech.example.md`, `files/mail/rules/@nordbank.example.md` — short mail rules ("archive invoices from FunkFix, note amount").
- `files/geschenkeliste-fritzi.md` / `files/gift-list-fritzi.md` — a table.
- `files/hackathon-notizen.md` / `files/hackathon-notes.md` — loose notes.

## Additions (people/places/self)

- Ines works at the physiotherapy practice "Bewegungsraum", Kaltenbach (30 h/week). The duplicate `ines.md` deliberately contradicts: "likes roses", "drives the Mazda", "Jürgen's wife".
- The duplicate `henrik.md` deliberately contradicts `henrik-sommer.md` ("has a son" vs. daughter Mia, 12; wife Anke).
- Gisela's children: Jürgen's father **Klaus** (died 2011), daughters Hedi and Roswitha. Will: Jürgen inherits the house, the daughters the cash. Grave care paid by Jürgen yearly in March.
- Aunts' visits: 2026-04-18 – 19 (asparagus dinner at Zum Schwan), next 2026-12-12 – 13.
- Katrin Brandt: Birkenweg 12, architectural draughtswoman. Pick-up after football: Tuesdays Katrin, Fridays Jürgen. Jannis has a **hazelnut allergy**.
- Tobias Hartl: IT admin at Klinikum Kaltenbach. Tobias Harter: partner at KRW Partner, Am Rathaus 3, assistant Ms Jäger; 2025 documents sent 2026-04-28.
- Björn Größler: master carpenter in Lauterbrunn; inspected the Alte Mühle with Jürgen in 2025-05.
- Brightwater: first call 2026-07-08, offer approved by Dirk Pohlmann 2026-07-22, **PO BW-2026-0815 issued 2026-08-12** by Selin Aydin, steering committee 2026-10-21 (phase 1 accepted), first invoice approved 2026-10-02.
- Ziegenbalg: office Hauptstraße 40, recommended by Henrik Sommer, first meeting 2026-08-20, exclusion = back.
- Brünnich: Kirchgasse 5, Unterbrunn; appointment 2025-01-14.
- Szymanski: asking price **189,000 €**, viewing/valuation 2025-06-03, three viewings 2025-09.
- Kai Wendt / Lumora: pitch 2026-04-23, talk 2026-05-06, Jürgen declined 2026-05-20; seeks 400,000 € pre-seed; slogans "Durchblick für jedes Lager" / "Mit Weitblick kommissionieren".
- Yusuf Demir founded the meetup 2025-11; Lisa Tran demoed Brotzeit 2026-09-10 and designed Thermo-Pi's web dashboard.
- Family Nowak: Marek (engineer, Sunday runs with Jürgen) and Julia (paediatrician), twins Ole and Ida (9); planning evening 2026-09-12.
- Dr. Reuter: check-up Jürgen 2026-02-10, Ines follow-up 2026-07-10, flu shots 2026-10-15; phone 06401 77 12 0.
- FunkFix tariffs: Jürgen "Pro M" 24,99 €, Ines "Basic" 9,99 €, Paul "Kids S" 6,99 €, Fritzi "Teen M" 12,99 €.
- Timeline: born 1978 in Unterbrunn, met Ines 2008, moved to Kaltenbach 2012-03, Fritzi born 2012-04, Paul 2016, freelance 2018, Mazda6 bought 2019, Lindenstraße 3 bought 2020, Thermo-Pi published 2022.
- Routines: Friday pizza, client day Wednesdays at Brightwater in Frankfurt. Food: Thai takeaway "Baan Siam".
- The board game is "Sternenimperium" in DE and "Star Empire" in EN.

## Additions (threads/journal)

- **Mühlbach-Bande** other members (no files): Carsten Ebeling (Hamburg), Uwe Rademacher (Kaltenbach, carpenter). Annual get-together 12-27 at Zum Schwan; hike 2026-05-30.
- **Board game night**: first Friday of the month; expansion "Sternenimperium: Grenzwelten" / "Star Empire: Frontier Worlds"; Björn wins often.
- **SPS/SPM talks**: 2026-04-09 Jürgen presents the Thermo-Pi license change; hackathon idea 2026-09-24, hostel offer 2026-10-20, reservation confirmed 2026-10-28, deposit due 2026-11-30.
- **Norway cabin**: total 6,900 €, deposit 2,070 € paid by Jürgen 2026-10-05, remaining payment due 2027-05-24, ferry from Hirtshals not yet booked.
- **Alte Mühle**: valuation ~240,000 €, asking price 259,000 €, rejected offer 190,000 € on 2025-12-03; neighbour Mr Brandl looks after it.
- **Inheritance**: notary appointment 2024-12-09, Erbschein issued 2025-01-21, land-registry correction filed 2025-01-28, completed 2025-02-20.
- **WEG Ahornweg 7**: administrator contact Ms Gerlach, roofers 2026-09-14 – 25. **WEG Lindenstraße 3**: new tenants from 2026-09-01, deposit 1,920 €, rent 640 €.
- **Tax 2025**: refund 1,240 €, assessment 2026-08-19.
- **Nordbank incident**: 2026-08-03 21:47, cause: leaked password, password changed 2026-08-04.
- **Car insurance**: Hanse Direkt 641 €/year (Mazda, from 2026-01-01); Hyundai premium +6 % for 2027.
- **Disability insurance**: premium 118 €/month from 2026-11-01, exclusion lumbar spine.
- **Vehicles**: registrations KB-JW 719 (Mazda) / KB-IW 21 (Hyundai); garages Autohaus Ostring (Mazda, tyre hotel) and Hellwig (Hyundai); parking dent 2026-07-06, smart repair 240 € on 2026-07-08; MOT Hyundai 2027-03, Mazda 2027-05.
- **Packages**: headphones from "Klangwerk" via PaketPilot (PP2026090388412, delivered 2026-09-04 to Henrik); ink cartridges from "Papierwelt" (PP2026100771930, 2026-10-08); garden hose from "Grünzeug" via Blitzbote (BB-70418836521, 2026-04-17).
- **ReTech**: refurbished Google Pixel 349 €, ordered 2026-09-15, set up 2026-09-22; work number FunkFix business 9,99 €.
- **Brightwater**: 40 days at 1,150 €, PO BW-PO-26-0817 (2026-08-11), test migration from 2026-11-09.
- **Dealflow**: Lumora declined 2026-10-21; invested 15,000 € in **Hoflix** (farm-shop platform, contract 2026-06-03); **Azubio** declined.
- **Summer holiday care**: town holiday programme 2026-07-20 – 08-07, family holiday on the Baltic coast 2026-08-10 – 08-21.
- **Optician**: Jürgen's varifocals 690 € picked up 2026-03-21; Fritzi's daily lenses subscription 24 €/month from 2026-10-03.
- **Journal**: 2026-05-14 first swim at the Kaltenbach quarry lake (Baggersee); 2026-05-21 Fritzi handball away win in Lauterbrunn; 2026-06-20 tournament, Fritzi's team second, classmate Leo.
