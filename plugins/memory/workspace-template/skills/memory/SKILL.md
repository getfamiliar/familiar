---
name: memory
description: How the agent's long-term memory is organized.
---

# The wiki

Long-term memory lives in markdown under `wiki/`. Every `.md` file in the workspace is
indexed and searchable via `memory_search`, but the wiki is where memories the agent
creates deliberately land.

## Folders

- `wiki/people/<slug>.md` — one file per person. Facts about who they are, your
  relationship, preferences, recent interactions.
- `wiki/threads/<slug>.md` — one file per ongoing topic, project, deal, or conversation
  that spans more than a single event.
- `wiki/places/<slug>.md` — one file per recurring location (homes, offices, regular
  venues, addresses).

Other folders can grow under `wiki/` as the need surfaces — invent a folder when an
existing one feels wrong.

## How chunking works

A memory file is **not** indexed as one big blob. The indexer splits each file on every
heading at level `#`, `##`, and `###` and treats each section as its own memory chunk.
A search hit returns the matching chunk together with its headline trail
(`# Adam Smith > ## Meetings > ### Atlanta 2026-05-12`), so the structure of the file
directly shapes how memories are addressable.

Practical consequences:

- **Use headings to mark distinct memories.** A new meeting, a new decision, a new
  fact about a different relationship — give each its own `##` or `###`. Don't pile
  everything under one heading; the search engine can't tell them apart.
- **Section bodies are what gets embedded.** Keep each section self-contained enough
  that someone reading it without seeing the headline trail still understands roughly
  what it's about.
- **Heading levels below h3 (`####`+) stay inside their parent chunk** — they're
  structure within a memory, not memory boundaries.

## The file-wide context paragraph

The **first plain paragraph after the document's top `# Title`** is treated as
file-wide context and prepended to every chunk's embedding for that file. Use it to
state in one sentence what the whole file is about.

```markdown
# Adam Smith

Senior PM at Acme; primary contact for the GTM workstream. Based in Atlanta.

## Meetings
...
```

If the file leads with a list, sub-heading, or code fence directly under the h1, the
context is empty and every chunk loses that document-wide framing. So: always write
that one-line description right under the h1.

## Wikilinks

Cross-link liberally: `[[alice-foo]]`, `[[acme-rollout]]`. Wikilinks are plain markdown
for now (no resolver) but they signal connection to future readers and add useful
co-occurrence signal to the index.

## Read-before-write discipline

Before writing a new memory, **always** run `memory_search` for the subject. If a file
already exists, extend it rather than creating a parallel one. Only create a new file
when no good home exists for the new fact.

## Style

- **Bullet points over prose.** Memories are reference material, not essays.
- **Date facts when the date matters.** Use absolute dates the reader can interpret
  without context: `- 2026-05-22: signed the NDA`.
- **Don't repeat what's already there.** Your job is to add, not duplicate. If the
  same fact is already recorded, leave the file alone.
- **Note uncertainty.** If something is a guess, mark it: `- (probably) lives in
  Berlin`.

## Slugs

Filenames are kebab-case slugs: `alice-smith.md`, `acme-rollout.md`, `office-berlin.md`.
Use the most identifying name available — a person's full name beats their first name.
