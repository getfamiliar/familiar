# Memory plugin

Long-term memory for the agent: every markdown file under `workspace/wiki/` is indexed in postgres, and the agent searches it with literal terms and ISO dates. The search is deliberately simple — no embeddings, no semantic ranking. The agent is expected to think: it sends names, synonyms, translations and categories as separate terms and reads the result table itself.

The plugin needs no configuration. Its tables live in the `memory` schema of the bus database (`familiar-postgres`); it uses the `pg_trgm` extension, which it creates itself.

## What the agent sees

| Tool | Effect |
|------|--------|
| `memory_search` | `terms`: 1–8 search terms, OR-combined. Returns a markdown table of matching files (path, title, description, categories, matched terms, best matching line), files matching the most terms first. |
| `memory_datesearch` | `from` + `to` (ISO dates) or `day` (`MM-DD`, any year). Returns every line with an ISO date in that range, with path and line text, ordered by date. |
| `memory_save` | Hands a fact to a reasoning agentrun (exact-topic `skills:memory:save` event → `skills/memory/save.md` handler) which decides where in the wiki it belongs and writes the file. Returns immediately; the watcher re-indexes the file once it is written. |

All three are in the `core` group, so every handler without a `tools:` list has them preloaded.

The placeholder `{MEMORY_CATEGORIES}` (used in the default `PROMPT.md`, after the cache marker) renders the categories in use with their file counts, e.g. `family (12), property (4), insurance (3)`. Nothing else is injected into the prompt: there is no automatic "relevant memories" section any more — the agent has to search actively.

`memory_save` is intentionally indirect. Every memory ends up as a markdown file the user can read and edit; the index is a derived artifact.

## Wiki file conventions

The index reads three things per file, which is why `skills/memory/SKILL.md` asks for them:

- **Title**: the first h1 (fallback: the file name).
- **Description**: the first plain paragraph directly under the h1.
- **Frontmatter**: optional `categories` (0–3 words, each naming a set of files one would ask for as a whole) and `review_at` (an ISO date for a later follow-up). Other frontmatter keys are ignored.

```markdown
---
categories: [property, inheritance]
review_at: 2026-11-20
---
# Alte Mühle Unterbrunn

Sale of the inherited house in Unterbrunn via broker Ralf Szymanski; notary date pending.
```

## How indexing works

Three tables in the `memory` schema:

| Table | Rows |
|-------|------|
| `files` | One per file: title, description (raw and normalized), categories, `review_at`, `last_touched` (the file's mtime), content hash. |
| `lines` | One per non-blank line: text (raw and normalized), whether it is a heading, the heading trail (`Alice Smith > Meetings`), a `simple` tsvector. Trigram GIN index on the normalized text. |
| `dates` | One per ISO date occurrence: path, line, `date_from` / `date_to`, `month_day` (for `day` searches), the line text. A month (`2026-07`) is stored as the range 2026-07-01 – 2026-07-31; bare years are not indexed. |

Normalization (lower case, no diacritics, `ß → ss`) happens in TypeScript for both stored text and search terms, so `Größler`, `GROESSLER` and `größler` meet in the index.

At daemon start the plugin syncs the whole `wiki/` folder in the background (unchanged files are skipped by content hash), then re-indexes each file the workspace watcher reports. Bump `INDEX_FORMAT_VERSION` in `WikiIndex.ts` when the parser or the columns change; every file is then rewritten on the next sync.

### Search

For each term and file the best `word_similarity` per field is weighted (title 4, category 3, description 3, heading 2, body line 1) and summed. Terms of up to four characters are matched as whole tokens instead of trigrams, which keeps `cars` from matching `Carla`. Files are ranked by the number of distinct terms they match, then by that score, then by recency. A term counts as matched from a word similarity of `memory.similarityThreshold` (default 0.6 — tolerates about one typo in a name while keeping `Hartl` and `Harter` apart).

## CLI

The commands work on the live index and need postgres running (`familiar start`). All human output supports `--raw`.

| Command | Output |
|---------|--------|
| `familiar memory search <term…>` | The `memory_search` table for the given terms (quote multi-word terms). |
| `familiar memory dates --from <date> --to <date>` / `--day MM-DD` | The `memory_datesearch` table. |
| `familiar memory show <path>` | What the index stores for one file: title, description, categories, `review_at`, dates. |
| `familiar memory categories` | The category list as `{MEMORY_CATEGORIES}` renders it. |
| `familiar memory reindex [--full]` | Syncs the index with `wiki/` now; `--full` drops it first. |
| `familiar memory eval` | Runs the eval set in `eval/` (fictional bilingual corpus, ~115 cases) against throwaway schemas `memory_eval_de` / `memory_eval_en` and reports Recall@5/@10, Hit@1, MRR and nDCG. See `eval/README.md`. |

## Configuration

Everything is optional:

```yaml
memory:
  searchLimit: 10             # files memory_search returns
  similarityThreshold: 0.6    # pg_trgm word similarity a term needs to count as a hit (0–1)
```

Both are read per call, so `familiar config reload` applies them immediately.

## Workspace template

Ships:

- `wiki/people/`, `wiki/threads/`, `wiki/places/` — folders where the agent files memories.
- `skills/memory/SKILL.md` — the wiki conventions: folders, slugs, title / description / frontmatter, ISO dates, how the search works and how to search well.
- `skills/memory/save.md` — the handler that `memory_save` dispatches to.

### `skills/memory/save.md` — the save handler

When any agent calls `memory_save("...")`, the plugin emits an exact-topic `skills:memory:save` event with the snippet as the prompt. The topic is the handler's address, so the container loads `workspace/skills/memory/save.md` and runs an agentrun against it. The handler is the policy that turns a one-line "remember this" into a markdown file under `wiki/` — the plugin itself never decides slugs, folder placement, or whether two facts should merge.

The handler reads the skill, searches for every distinctive name and noun in the snippet (with synonyms and categories), reads candidate files, then extends one or creates a new file with frontmatter, title and description, and replies with a one-line summary (`extended wiki/people/alice.md`, `created wiki/threads/acme-rollout.md`, or `noop — already recorded`). These are judgement calls, so `save.md` runs under the `smart` model alias.

## Leftovers from the Orama index

Earlier versions kept an Orama index in `data/memory/` (`memory.msp`, `embedding.json`). Nothing reads it any more; delete the folder. The `memory.embeddings`, `memory.hybridWeights` & co. keys in `config.yml` are ignored and can be removed.
