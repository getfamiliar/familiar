# Memory plugin

Long-term memory for the agent, backed by [Orama](https://docs.orama.com)'s
hybrid (vector + BM25) search over every markdown file in
`data/workspace/`. Surfaces relevant snippets in the agent's system prompt,
exposes `memory_search` / `memory_save` tools, and ships a CLI for
inspection.

The plugin needs an embedding provider and model in `config.yml`. Without
those, it logs a clear "disabled — pending config" line and leaves the rest
of the daemon untouched.

## What the agent sees

Two integration points fire automatically on every agentrun:

1. A **context provider** that turns the agentrun's prompt into a hybrid
   search query and injects relevant memories into the system prompt under
   a `# Memories` section.
2. Two **agent tools** (`memory_search`, `memory_save`) the agent can call
   on demand.

### Injected `# Memories` section

```
# Memories

Files matching your prompt including descriptions are listed below. Use `fs_read` if you want to read the full file; use `memory_search` to look up more memories on demand.

| File | Score (1-100) | Description |
| - | - | - |
| `wiki/people/alice.md` | 88 | Senior PM at Acme; primary GTM contact. Based in Atlanta. |
| `mail/index.md` | 64 | Triage incoming mail and decide what to do with it. |
| `mail/rules/adam@weeklyfoo.com.md` | 58 | (Handler file) |
```

No chunk bodies are inlined — the agent reads full files on demand via
`fs_read`. The table lists one row per matched file, best score first.
Files whose best hit scores at or below `minScoreToMention` are dropped;
at most `maxSystemPromptMemoryResults` files are shown. When nothing
clears the floor the section is a short stub pointing at `memory_search`.

Each file's **description** comes from one of two sources, chosen by
whether the file is one of the assistant's own writable memory files
(`core.writablePaths`, default `wiki/**`):

| File kind | Description source |
|-----------|--------------------|
| Under `core.writablePaths` (curated memory) | The file's first paragraph — our memory convention. Falls back to the first content line if the file has none. |
| Anything else (handler files, rules, …) | The YAML `description:` frontmatter, or the `(Handler file)` placeholder. Never the body — handler prose would pose as direction addressed at the agent. |

All descriptions are reduced to plain text (markup stripped, whitespace
collapsed) and truncated to 200 characters.

### Agent tools

| Tool | Effect |
|------|--------|
| `memory_search` | Hybrid search against the index. Returns every hit (no threshold filtering) so the agent can judge relevance from snippets and scores. |
| `memory_save` | Hand a fact to a reasoning agentrun (`skills:memory` event → `save.md` handler) which decides where in the wiki it belongs and writes the file. Returns immediately; the indexer picks the new file up on the next file-watcher tick. |

`memory_save` is intentionally indirect. The agent doesn't write directly to
the index — every memory ends up as a markdown file the user can read and
edit. That keeps the workspace authoritative and the index a derived
artifact.

## How indexing works

### Chunking

Every `.md` file in `data/workspace/` (except those matching `excludeGlobs`)
is split into chunks on every h1/h2/h3 heading. Each chunk gets:

- **`headlines`** — the full trail to that section, e.g.
  `# Adam Smith > ## Meetings > ### Atlanta 2026-05-12`.
- **`context`** — the first plain paragraph after the document's leading
  h1, attached to every chunk in the file so the embedding always has the
  document-wide framing.
- **`content`** — the section body verbatim, minus the heading line.

Headings inside fenced code blocks are not treated as headings. Files
without any h1/h2/h3 (typically `mail/rules/*.md`) fall back to a single
synthesized chunk whose headline is `# <path-stem>`, so they stay
searchable.

### Embedding identity

`data/memory/embedding.json` records the provider, model, and vector
dimension the index was built with. On every startup the plugin:

1. Probes the live config against the recorded identity.
2. If they differ (different model, different dimension), deletes
   `data/memory/memory.msp` and logs the rebuild reason. The fresh index
   re-embeds every file in the workspace.
3. If they match, skips the trial-embed call (no wasted API roundtrip).

The embedding model is built via a small isolated factory
(`EmbeddingModelFactory.ts`). Supported provider types: `openai`,
`google`, `mistral`, `openai-compatible`. Anthropic, deepseek, grok, and
groq are explicitly rejected with a clear "this provider does not expose
embeddings" message — they're listed in `inference.apiKeys` only for chat.

### Diff-aware re-embed

When a file changes, the indexer does **not** re-embed it wholesale. It
diffs the new chunks against the old by content hash
(`sha256(headlines + context + content)`):

- Unchanged chunks → only `lastModified` is touched.
- New chunks → embedded and inserted.
- Gone chunks → removed.

So editing one paragraph in a 50-section file costs one embedding call.

### Async update queue

All workspace edits (initial scan + live watcher deltas) flow through one
in-memory `Map<path, "upsert" | "remove">` queue drained by a single
worker. The plugin's `start()` returns immediately after loading the
existing index — the daemon never blocks on embedding traffic. `isReady()`
flips true once the initial batch drains, and a "memory: plugin live with
X files / Y chunks indexed" line lands in the log.

### Persistence

The Orama index is persisted to `data/memory/memory.msp` (msgpack-encoded)
via `@orama/plugin-data-persistence`. Writes are debounced — every index
mutation resets a `persistToDiskDelay`-second timer, and the plugin
flushes once the timer elapses or `stop()` is called during daemon
shutdown.

Restore goes through Orama's `load(db, raw)` rather than the plugin's
`restoreFromFile`. The latter bakes a placeholder schema into the
restored DB, which silently breaks new inserts; building our own DB with
the real schema first and then loading the raw data avoids that trap.

### Search

```ts
search(db, {
    mode: "hybrid",
    term: query,
    vector: { value: await embed(query), property: "embedding" },
    similarity: cfg.minVectorSimilarity,
    hybridWeights: cfg.hybridWeights,
    limit: cfg.maxSystemPromptMemoryResults,
});
```

Two non-obvious choices:

- **`similarity` is set explicitly**, not left to Orama's default. Orama
  defaults to a 0.8 cosine-similarity floor, which prunes nearly every
  semantically related (but not literal) match before the hybrid merge.
  The default here is `0.3` — permissive enough that the vector side
  actually contributes.
- **All string fields are searched** (`path`, `headlines`, `context`,
  `content`, `contentHash`). The path being searchable is a feature:
  typing `alice` matches `wiki/people/alice.md` even if the body never
  spells out "alice".

## CLI

| Command | Output |
|---------|--------|
| `./cli.sh memory search "<query>"` | Hybrid-search the index. Same renderer the agent uses for `memory_search`, piped through the terminal markdown renderer. Every hit is shown with its raw score — no threshold filtering. |
| `./cli.sh memory show <path>` | Every indexed chunk for one workspace-relative path, with `Path "..."` headers and the section content. |
| `./cli.sh memory list` | Every indexed file alphabetically, with chunk count and lastModified. Warns + lists timestamps if chunks of one file disagree on mtime. |

All three commands work standalone (no daemon required). They build their
own short-lived MemoryStore against the persisted index, so what they show
is whatever was last flushed to disk — recent edits may not yet be
visible if the daemon hasn't flushed.

## Configuration

```yaml
memory:
  # Required — no default, plugin self-disables without these.
  embeddings:
    provider: openai                  # must match inference.apiKeys.<id> or inference.customProviders.<id>
    model: text-embedding-3-small     # embedding model under the provider

  # Thresholds governing the # Memories injection (range 0–1).
  minScoreToMention: 0.55             # score floor for the table; files at/below are dropped
  minVectorSimilarity: 0.3            # cosine-similarity floor for vector hits (Orama's default 0.8 is too strict)

  # Retrieval limits.
  maxSystemPromptMemoryResults: 8     # max files listed in the injected # Memories table
  maxToolMemoryResults: 5             # default `limit` for the memory_search tool

  # Path filters (substring-with-* grammar).
  excludeGlobs: []                    # not indexed at all

# Each file's description source in the # Memories table is driven by the
# platform-level `core.writablePaths` (default ["wiki/**"]) — see the `core:`
# group. Writable-path files use their first paragraph; others use their
# `description:` frontmatter.

  # Search tuning.
  language: english                   # stemmer + stopwords; falls back to english if unknown
  hybridWeights:
    vector: 0.5
    text: 0.5

  # Persistence.
  persistToDiskDelay: 30              # seconds of index idleness before the dirty .msp gets flushed
```

The `embeddings.provider` value **references** an entry already declared
under `inference.apiKeys.<id>` (native vendor) or
`inference.customProviders.<id>` (third-party gateway). API key and base
URL are read from there — never restated in the `memory:` subtree.

28 stemmer/stopwords languages ship: arabic, armenian, bulgarian, danish,
dutch, english, finnish, french, german, greek, hungarian, indian,
indonesian, irish, italian, lithuanian, nepali, norwegian, portuguese,
romanian, russian, sanskrit, serbian, spanish, swedish, tamil, turkish,
ukrainian. Unknown values log an error listing the supported set and
fall back to english.

## Workspace template

Ships:

- `wiki/people/`, `wiki/threads/`, `wiki/places/` — folders where the
  agent files memories created via `memory_save`.
- `skills/memory/SKILL.md` — read-only doc explaining the chunking model,
  the file-wide context paragraph, slugs, and read-before-write
  discipline. Handlers can reference it in prose ("read
  `skills/memory/SKILL.md` first") to teach the agent.
- `skills/memory/save.md` — the handler that `memory_save` dispatches to.

### `skills/memory/save.md` — the save handler

When any agent (or any tool) calls `memory_save("...")`, the plugin
emits a `skills:memory` event with the snippet as the prompt. The
container's handler resolver loads `workspace/skills/memory/save.md`
and runs an agentrun against it. The handler is the policy that turns
a one-line "remember this" into a markdown file under `wiki/` — the
plugin itself never decides slugs, folder placement, or whether two
facts should merge.

What `save.md` is responsible for:

1. **Reading `skills/memory/SKILL.md`** to recall the wiki layout
   (`people/` vs `threads/` vs `places/`), slug conventions, and the
   read-before-write rule.
2. **`memory_search`** on every distinctive noun in the snippet to find
   existing files that already cover the topic.
3. **Reading any candidate match** before writing, so it can extend
   rather than duplicate.
4. **Choosing a folder + slug** for net-new memories (e.g. is this a
   person, an ongoing thread, or a place?) and writing the file with
   `fs_write`.
5. **Cross-linking** related notes with `[[other-slug]]`.
6. **Replying with a one-line summary** (`extended wiki/people/alice.md`,
   `created wiki/threads/acme-rollout.md`, or `noop — already
   recorded`).

Each of those steps is a judgement call — synonym resolution, slug
naming, merge-vs-new — so the handler benefits significantly from a
**reasoning-capable model**. A small/fast model will drop facts on the
floor (creates a new file instead of finding the existing one, picks a
slug that won't match next time, or silently duplicates). Recommended
setup: add a `model:` line to `save.md`'s frontmatter pointing at the
strongest model you have available, e.g.:

```yaml
---
tools: fs_read, fs_write, memory_search
model: deepseek/deepseek-reasoner   # or anthropic/claude-opus-4-7, openai/o1, …
---
```

Without a `model:` line the handler runs under `inference.defaultModel`
from `config.yml` — fine if your default is already a reasoning model,
worth overriding otherwise.

`save.md` is a regular workspace handler, so editing it lets you reshape
the policy: add domain-specific folders (`wiki/companies/`,
`wiki/recipes/`), tighten the slug grammar, require dated headlines for
every new fact, refuse to save certain categories of content, whatever
the workspace needs. The plugin's job is to dispatch the event and
re-index whatever ends up on disk.

## On-disk layout

```
data/memory/
  embedding.json      # { provider, model, dimension } — identity used to detect config drift
  memory.msp          # msgpack-encoded Orama index; rewritten by the debounced flush
```

Both files are safe to delete:

- `rm data/memory/memory.msp` — next daemon start re-embeds every file from
  scratch.
- `rm data/memory/embedding.json` — next start re-runs the trial-embed
  (one API call) to rediscover the vector dimension. Also triggers an
  index rebuild if the dimension turns out different from what's in the
  current `.msp`.
