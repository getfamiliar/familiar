# Memory search eval set

A fixed, fully fictional workspace plus a list of search cases for measuring the quality of the memory plugin's search: does the right file come back (recall), how high does it rank (ranking), and can a score threshold separate relevant from irrelevant hits (score separability)? Every case exists in German and English, so language effects (stemming, compounds, umlauts, cross-language queries) show up as a difference between the two runs.

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
  ValidateCases.ts   # structural check of cases.yml (ids, categories, paths, grades)
```

The loader/validator, the metrics and the runner live in the plugin's `src/` (`EvalCases.ts`, `EvalMetrics.ts`, `EvalRunner.ts`, `EvalReport.ts`) so the CLI command can use them.

Each `corpus/<lang>/` folder is a workspace root: index it as if it were `workspace/`. Besides the wiki it contains a few deliberate distractors outside the wiki (handler files, mail rules, `files/`), because the real index covers every markdown file.

The large, noise-heavy files (`wiki/threads/thermo-pi.md` ~150 KB, the WhatsApp digest ~50 KB) are generated. Regenerate them from the repo root with:

```bash
npx tsx plugins/memory/eval/GenerateNoise.ts
```

The output is deterministic (seeded PRNG) and committed, so results stay comparable. Do not edit the generated files by hand; change the script instead.

## Case format

```yaml
- id: typo-01
  category: typo
  origin: "A doubled letter in a distinctive word, with only one weak companion term."
  query: { de: "Sternenimperrium", en: "Star Emprie" }
  relevant:            # grade 2 = must be found, 1 = acceptable
    de: { wiki/threads/brettspielabend.md: 2, wiki/people/tobias-hartl.md: 1 }
    en: { wiki/threads/board-game-night.md: 2, wiki/people/tobias-hartl.md: 1 }
```

- `id` — unique, `<category>-<nn>`.
- `category` — one of the category ids below.
- `origin` — the problem pattern the case reproduces (see "Origins"), in generic words.
- `query.de` / `query.en` — the query per language. Queries may contain deliberate typos.
- `relevant.de` / `relevant.en` — expected files per corpus, as **workspace-relative paths** (relative to `corpus/<lang>/`, exactly as the memory store indexes them: `wiki/people/ines-weiss.md`, `files/hackathon-notizen.md`), with grade `2` (must be found) or `1` (acceptable). Files not listed count as irrelevant (grade 0) — this includes handler files and mail rules unless they hold the answer. An **empty map** marks a **negative case**: nothing relevant exists, and every hit is a false positive. Only the `negative` category has empty maps.
- `crossLanguage: true` (optional) — in addition to the two normal runs (DE query on DE corpus, EN query on EN corpus), the **English** query also runs against the **German** corpus and is judged against `relevant.de`. Models the real situation of English handler prompts searching German memories; the normal runs serve as the per-language baseline.

## Categories

| Id | Category | Purpose |
|---|---|---|
| `exact-name` | exact name / entity | baseline: full names, project names |
| `typo` | typo (1–2 edits) | small misspellings must not drop the right file |
| `compound` | compound: part word, linking s/-en | German compounds and their variants |
| `inflection` | inflection / stemming | checks the stemmer and `memory.language` |
| `synonym` | synonym / paraphrase | the value of the embedding |
| `semantic` | semantically related, lexically foreign | a category word finds an object with a fantasy name |
| `date` | date search (`-07-12`, month) | ISO date convention vs. other date formats in queries |
| `noise` | fact in the noise of a giant file | chunk dilution |
| `duplicate` | duplicate: both files expected | merge candidates |
| `cross-language` | cross-language (EN query on DE corpus) | English handler prompts against German content |
| `long-prompt` | long prompt as query (whole mail) | the way the prompt appender searches |
| `keyword-salad` | keyword salad | agent queries stuffed with many terms |
| `abbreviation` | abbreviation | queries using only a group's or project's acronym |
| `distractor` | non-wiki distractor | handler files, mail rules and `files/` competing with the wiki |
| `negative` | negative: nothing relevant exists | calibrating score thresholds |

## Validation

After editing `cases.yml`, run the structural check from the repo root:

```bash
npx tsx plugins/memory/eval/ValidateCases.ts
```

It checks unique ids, known categories, both queries, that every expected path exists in its corpus and that grades are 1 or 2, and prints the number of cases per category.

## Running the eval

From the repo root (`npm run dev -- memory eval …` in a checkout):

```bash
familiar memory eval                      # both corpora + the en→de cross-language run
familiar memory eval --misses             # also list every case whose top file is not relevant
familiar memory eval --lang de --category typo,date
familiar memory eval --language german --json tmp/eval-german.json
```

The runner uses the `memory.*` settings from `config.yml` (embedding model, tokenizer language, hybrid weights, similarity floor, `minScoreToMention`); `--language`, `--vector-weight` (text weight = 1 − value) and `--min-similarity` override single settings for experiments. Each corpus is indexed with the real `MemoryStore` into a cached index under `tmp/memory-eval/<corpus>-<tokenizer language>-<maxChunkChars>/`, so repeated runs only pay for the query embeddings (~240 calls); a different embedding model rebuilds the cache automatically. Delete `tmp/memory-eval/` to force a full re-index. `--json <file>` writes every case result (ranked files with scores, metrics) for diffing two runs.

Per query the store returns up to 60 chunk hits; they are collapsed to one entry per file (best chunk score), as the prompt appender does, and the top 20 files are scored.

## Metrics

- **Hit@1** — the top file has grade ≥ 1.
- **Recall@5** — share of grade-2 files (grade-1 files when a case has none) in the top 5.
- **MRR** — mean of 1 / rank of the first file with grade ≥ 1 (0 when not in the top 20).
- **nDCG@10** — discounted gain over the top 10 with gain = grade.
- **Separation AUC** — probability that a case's best relevant file scores higher than an irrelevant top-10 file or a negative case's top file. 1.0 means one global score floor could separate them, 0.5 is chance.
- **Score distribution** — p10 / p50 / p90 of the best relevant file per case, of irrelevant top-10 files, and of the top file of negative cases.
- **Threshold sweep** — for score floors 0.30 … 0.90 (plus the configured `minScoreToMention`): share of cases whose best relevant file stays visible, share of irrelevant files that stay visible, share of negative cases that would show nothing.

Ranking metrics are reported per run (`de`, `en`, `en→de`) and per category; negative cases only contribute to the score distribution and the sweep.

## Origins

The scenarios reproduce problem patterns observed in the search logs of a real assistant wiki. No content, names, places or companies were taken over; the patterns are:

1. **Noise beats relevance.** A query about eye surgery ranked a thread with no relation to eyes first, ahead of the file about the optician. A query about a note-taking device ranked an unrelated person file first with a high score.
2. **Negative queries score high.** A query for an event with no file at all got a best score of about 0.7; a vague "open tasks, deadlines" query got 0.85 for a generic file. No threshold separates these from real hits.
3. **Exact full names lose.** A full-name query ranked a different person with the same first name first, and the right person's file did not appear. A surname with ß/ü was not found although the file existed with a transliterated slug (`ss`/`ue`).
4. **Duplicate person files** (`<firstname>.md` next to `<firstname-lastname>.md`), and name spelling variants (two common spellings of the same first name).
5. **A category word misses an object with a fantasy name.** A house known by a proper name was found only weakly by a query for "property sale", because the category is mentioned only in the body.
6. **Keyword-salad queries.** Agents stuff eight or more names and terms into one query; the result is a flat mush of scores around 0.5.
7. **Date format mismatch.** Agents search for dates in the local `DD.MM.YYYY` format while the wiki uses ISO `YYYY-MM-DD`.
8. **A bare first name** returns a dozen hits with nearly identical scores, all noise.
9. **Files outside the wiki compete.** Handler files, mail rules and loose files rank above the wiki file that actually holds the fact.
10. **Typos** in a distinctive word: survived only when the other query terms carried the search.

## Extending the set

- **Fictional only.** Never copy real names, addresses, companies, numbers or events from a real workspace. Reproduce the *pattern* in the fictional world.
- **`persona.md` first.** New people, places or facts go into `persona.md` before they appear in a corpus file or a case, so the world stays consistent.
- **Both languages in sync.** Every corpus change is made in `corpus/de/` and `corpus/en/`; every case has both queries and both relevance maps.
- **Mind the traps.** Some names and words must appear only in specific files or nowhere (see `persona.md`, e.g. "Leo", "Tom"). Check with `grep` after editing.
- **Noise via the script.** Change `GenerateNoise.ts` and rerun it instead of editing generated files; buried facts must stay unique (one occurrence per language).
