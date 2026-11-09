# Memory search eval set

A fixed, fully fictional workspace plus a list of search cases for measuring the quality of the memory plugin's search: does the right file come back within the first results (recall), and how high does it rank? Every case exists in German and English, so language effects (compounds, umlauts, cross-language searches) show up as a difference between the two runs.

The search is literal (`memory_search` takes 1–8 terms, `memory_datesearch` a date range or a day), and the agent is expected to formulate good terms. So each case carries both the user's prompt (`query`) and the terms a careful agent would send (`terms` / `dates`). The deterministic run measures the index with those terms; the LLM run lets a model formulate the terms from the prompt and measures the whole chain.

Run it with `familiar memory eval` (see "Running the eval").

## Layout

```
eval/
  README.md          # this file
  persona.md         # the fictional world: people, places, threads, deliberate traps — source of truth
  corpus/
    de/              # German workspace (wiki/, files/, chat/, mail/), natural German slugs
    en/              # the same workspace in English, natural English slugs
  cases.yml          # the search cases, each bilingual
  GenerateNoise.ts   # deterministic generator for the large noise files
  GenerateCrowd.ts   # deterministic generator for the crowd
  ValidateCases.ts   # structural check of cases.yml (ids, categories, paths, grades)
```

The loader/validator, the metrics and the runner live in the plugin's `src/` (`EvalCases.ts`, `EvalMetrics.ts`, `EvalRunner.ts`, `EvalReport.ts`) so the CLI command can use them.

Each `corpus/<lang>/` folder is a workspace root. Only its `wiki/` folder is indexed, like in the real workspace; the few files outside the wiki (handler files, mail rules, `files/`) stay as a reminder that they are not part of the memory, and no case expects them. Every wiki file carries frontmatter with 1–3 `categories` from the vocabulary in `persona.md` (a few threads also a `review_at`).

The large, noise-heavy files (`wiki/threads/thermo-pi.md` ~150 KB, the WhatsApp digest ~50 KB) are generated. Regenerate them from the repo root with:

```bash
npx tsx plugins/memory/eval/GenerateNoise.ts
```

The output is deterministic (seeded PRNG) and committed, so results stay comparable. Do not edit the generated files by hand; change the script instead.

The **crowd** — 200 people and 100 threads per language around the persona's wider circle, with deliberately confusable names (several Tobias, Mara/Maria/Marah, surnames like Hartmann, Lindquist, Ostermeier one to three edits away from persona surnames) — is generated too, so a misspelled or ambiguous name has to beat realistic competition instead of winning by being the only person file. Regenerate it with:

```bash
npx tsx plugins/memory/eval/GenerateCrowd.ts
```

It writes `corpus/<lang>/.crowd-manifest.json`; a rerun deletes exactly the files listed there and refuses to overwrite anything else. Before writing, it throws if any generated text contains a persona name or proper noun, a negative-case term, a topic a positive case asks about, or a date used in `cases.yml` / `persona.md`. Crowd files are never expected results: every case's relevance maps point at hand-written files only. Do not edit crowd files by hand; change the script.

## Case format

```yaml
- id: typo-01
  category: typo
  origin: "A doubled letter in a distinctive word, with only one weak companion term."
  query: { de: "Sternenimperrium", en: "Star Emprie" }
  terms: { de: ["Sternenimperrium", "Sternenimperium", "Brettspiel"], en: ["Star Emprie", "Star Empire", "board game"] }
  relevant:            # grade 2 = must be found, 1 = acceptable
    de: { wiki/threads/brettspielabend.md: 2, wiki/people/tobias-hartl.md: 1 }
    en: { wiki/threads/board-game-night.md: 2, wiki/people/tobias-hartl.md: 1 }
```

- `id` — unique, `<category>-<nn>`.
- `category` — one of the category ids below.
- `origin` — the problem pattern the case reproduces (see "Origins"), in generic words.
- `query.de` / `query.en` — the user's prompt per language (input of the LLM run). Prompts may contain deliberate typos.
- `terms.de` / `terms.en` — 1–8 terms a careful agent would send to `memory_search` (input of the deterministic run). Write them **from the prompt, not from the answer**: typos in names stay (the agent can't know the right spelling), dictionary words and brands may be corrected, synonyms, translations and fitting categories may be added — but nothing that only someone who knows the expected file would add.
- `dates` — `{ from: YYYY-MM-DD, to: YYYY-MM-DD }` or `{ day: MM-DD }`: the `memory_datesearch` a careful agent would run (same in both languages). A case may have `terms`, `dates` or both; with both, files found by both searches rank first.
- `relevant.de` / `relevant.en` — expected files per corpus, as **workspace-relative paths under `wiki/`** (`wiki/people/ines-weiss.md`), with grade `2` (must be found) or `1` (acceptable). Files not listed count as irrelevant. An **empty map** marks a **negative case**: nothing relevant exists. Only the `negative` category has empty maps.
- `crossLanguage: true` (optional) — in addition to the two normal runs, the **English** terms also run against the **German** corpus and are judged against `relevant.de`. Models English handler prompts searching German memories; a good agent adds terms in the wiki's language.

## Categories

| Id | Category | Purpose |
|---|---|---|
| `exact-name` | exact name / entity | baseline: full names, project names |
| `typo` | typo (1–2 edits) | small misspellings must not drop the right file |
| `compound` | compound: part word, linking s/-en | German compounds and their variants |
| `inflection` | inflection | plural, genitive and verb forms without a stemmer |
| `synonym` | synonym / paraphrase | only found when the agent adds the right synonyms |
| `semantic` | semantically related, lexically foreign | a category word finds an object with a fantasy name |
| `date` | date search (day of year, day, month) | `memory_datesearch` over ISO dates, whatever format the prompt uses |
| `noise` | fact in the noise of a giant file | one line in a 150 KB file must still surface |
| `duplicate` | duplicate: both files expected | merge candidates |
| `cross-language` | cross-language (EN query on DE corpus) | English handler prompts against German content |
| `long-prompt` | long prompt (whole mail) | the agent must pick the right terms from a mail |
| `keyword-salad` | keyword salad | agent queries stuffed with many terms |
| `abbreviation` | abbreviation | queries using only a group's or project's acronym |
| `distractor` | distractor | invoices, notices and lists that look alike |
| `negative` | negative: nothing relevant exists | few results, and none matching all terms |

## Validation

After editing `cases.yml`, run the structural check from the repo root:

```bash
npx tsx plugins/memory/eval/ValidateCases.ts
```

It checks unique ids, known categories, both queries, the terms (1–8 per language) and dates, that every expected path exists in its corpus under `wiki/` and that grades are 1 or 2, and prints the number of cases per category.

## Running the eval

From the repo root (`npm run dev -- memory eval …` in a checkout), with postgres running (`familiar start`):

```bash
familiar memory eval                      # both corpora + the en→de cross-language run
familiar memory eval --misses             # also list every case with a must-have file outside the top 5
familiar memory eval --lang de --category typo,date
familiar memory eval --threshold 0.65 --weights 4,3,3,2,1 --json tmp/eval.json
```

Each corpus's `wiki/` is indexed with the real `WikiIndex` into its own postgres schema (`memory_eval_de`, `memory_eval_en`) in the bus database. Unchanged files are skipped by content hash, so repeated runs take seconds; `--reindex` drops the schemas first. `--threshold` and `--weights` (title, category, description, heading, body) override the search defaults for experiments. `--json <file>` writes every case result for diffing two runs.

Each case's terms are sent to the same `searchFiles` the `memory_search` tool uses, its dates to `searchDates`; the top 20 files are scored.

## Metrics

- **Recall@5** — share of grade-2 files (grade-1 files when a case has none) in the top 5. The main measure: the agent reads the whole result table, so a must-have file at rank 4 is fine.
- **Recall@10** — the same within the top 10.
- **Hit@1** — the top file has grade ≥ 1.
- **MRR** — mean of 1 / rank of the first file with grade ≥ 1 (0 when not in the top 20).
- **nDCG@10** — discounted gain over the top 10 with gain = grade.
- **Negative cases** — number of results and how many of the terms the top file matched. Scores are not calibrated across searches (files rank by matched-term count first), so there is no score floor to tune; what lets the agent conclude "nothing known" is an empty table or a top file matching only some terms.

Ranking metrics are reported per run (`de`, `en`, `en→de`) and per category.

## Origins

The scenarios reproduce problem patterns observed in the search logs of a real assistant wiki. No content, names, places or companies were taken over; the patterns are:

1. **Noise beats relevance.** A query about eye surgery ranked a thread with no relation to eyes first, ahead of the file about the optician. A query about a note-taking device ranked an unrelated person file first with a high score.
2. **Negative queries score high.** A query for an event with no file at all got a best score of about 0.7; a vague "open tasks, deadlines" query got 0.85 for a generic file. No threshold separates these from real hits.
3. **Exact full names lose.** A full-name query ranked a different person with the same first name first, and the right person's file did not appear. A surname with ß/ü was not found although the file existed with a transliterated slug (`ss`/`ue`).
4. **Duplicate person files** (`<firstname>.md` next to `<firstname-lastname>.md`), and name spelling variants (two common spellings of the same first name).
5. **A category word misses an object with a fantasy name.** A house known by a proper name was found only weakly by a query for "property sale", because the category is mentioned only in the body.
6. **Keyword-salad queries.** Agents stuff eight or more names and terms into one query; the result is a flat mush of scores around 0.5.
7. **Date format mismatch.** Agents search for dates in the local `DD.MM.YYYY` format while the wiki uses ISO `YYYY-MM-DD` — now the agent converts the date for `memory_datesearch`.
8. **A bare first name** returns a dozen hits with nearly identical scores, all noise.
9. **Files outside the wiki compete.** Handler files, mail rules and loose files rank above the wiki file that actually holds the fact.
10. **Typos** in a distinctive word: survived only when the other query terms carried the search.

## Extending the set

- **Fictional only.** Never copy real names, addresses, companies, numbers or events from a real workspace. Reproduce the *pattern* in the fictional world.
- **`persona.md` first.** New people, places or facts go into `persona.md` before they appear in a corpus file or a case, so the world stays consistent.
- **Both languages in sync.** Every corpus change is made in `corpus/de/` and `corpus/en/`; every case has both queries, both term lists and both relevance maps.
- **Frontmatter.** New wiki files get `categories` from the vocabulary in `persona.md`.
- **Mind the traps.** Some names and words must appear only in specific files or nowhere (see `persona.md`, e.g. "Leo", "Tom"). Check with `grep` after editing.
- **Noise via the script.** Change `GenerateNoise.ts` and rerun it instead of editing generated files; buried facts must stay unique (one occurrence per language).
- **Crowd via the script.** When a new case introduces a name, a proper noun or a topic, add its distinctive words to `FORBIDDEN_TERMS` in `GenerateCrowd.ts` and rerun it, so no crowd file accidentally answers the case.
