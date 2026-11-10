---
tools: fs_read, fs_write, fs_str_replace, fs_append, memory_search, memory_datesearch
# Filing a memory is a judgement call (which folder? which slug? extend existing or
# write new?), so this should be a reasoning-capable model — not a small/fast one.
model: smart
---

# File this memory

A piece of information arrived. Decide where in the wiki it belongs and write it there. The content to file is the prompt of this run.

Procedure:

1. Read `skills/memory/SKILL.md` once if you haven't already this run. It defines the wiki layout (people / threads / places), the frontmatter, the wikilink convention and the style rules.
2. Use `memory_search` to find existing notes that overlap with this content. The search is literal: send every name, project, place and distinctive noun in the content as its own term, plus synonyms and the matching memory categories. For dates in the content, `memory_datesearch` finds what is already recorded on that day.
3. If a matching file exists, **read it first**, then extend it with the new fact. Don't duplicate what's already there.
4. If no matching file exists, create one with a kebab-case slug in the right folder (`wiki/people/<slug>.md`, `wiki/threads/<slug>.md`, etc.): frontmatter with 0–3 `categories` (only existing ones from the prompt that really fit), the h1, then the one-line description paragraph. Cross-link related notes with `[[other-slug]]`.
5. Keep it terse: bullet points, not prose. Date facts when the date matters, always as ISO dates.
6. If something about the subject stays unclear (how the user knows a person, what a thread is about), add a question to `wiki/questions.md`.
7. Cleanup if necessary - simplify, rename, merge, fix typos. The wiki is your baby; take care of it.

## Your output

Reply with a one-line summary of what you did (`extended wiki/people/alice.md`, `created wiki/threads/acme-rollout.md`, or `noop — already recorded`).
