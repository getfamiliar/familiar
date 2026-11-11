---
tools: fs_read, fs_write, fs_str_replace, fs_append, memory_search, memory_datesearch
# Filing a memory is a judgement call (which folder? which slug? extend existing or
# write new?), so this should be a reasoning-capable model — not a small/fast one.
model: smart
---

# File this memory

A piece of information arrived. Decide where in the wiki it belongs and write it there. The content to file is the prompt of this run.

Procedure:

1. Read `skills/memory/SKILL.md` once if you haven't already this run. It defines the wiki layout (people / threads / self / journal), what belongs in the memory, the frontmatter, the wikilink convention and the style rules.
2. **Decide what is worth keeping.** Ask of every detail in the content: *Will this still be useful to someone reading the file in three months?* Drop your own processing (mail and event ids, archived / trashed / digest, verified via API, duplicates, "nothing new") and copied source text — see "What belongs in the memory" in the skill. If nothing lasting is left, write nothing and reply `noop — nothing lasting`.
3. Use `memory_search` to find existing notes that overlap with this content. The search is literal: send every name, project, place and distinctive noun in the content as its own term, plus synonyms and the matching memory categories. For dates in the content, `memory_datesearch` finds what is already recorded on that day.
4. If a matching file exists, **read it first**, then extend it with the new fact. Don't duplicate what's already there. When the fact changes the status of a matter, update the status in place instead of appending a new "Status" or "Addendum" section.
5. If no matching file exists, create one with a kebab-case slug in the right folder (`wiki/people/<slug>.md`, `wiki/threads/<slug>.md` or the thread cluster it belongs to, etc.): frontmatter with 0–3 `categories` (only existing ones from the prompt that really fit), the h1, then the one-line description paragraph. Cross-link related notes with `[[other-slug]]`.
6. Keep it terse: bullet points, not prose. Date facts when the date matters, always as ISO dates.
7. If something about the subject stays unclear (how the user knows a person, what a thread is about), add a question to `wiki/questions.md`.
8. Cleanup if necessary - simplify, rename, merge, fix typos. The wiki is your baby; take care of it.

## Your output

Reply with a one-line summary of what you did (`extended wiki/people/alice.md`, `created wiki/threads/acme-rollout.md`, `noop — already recorded` or `noop — nothing lasting`).
