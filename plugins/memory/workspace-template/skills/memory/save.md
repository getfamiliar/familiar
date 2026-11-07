---
tools: fs_read, fs_write, fs_str_replace, fs_append, memory_search
# Filing a memory is a judgement call (which folder? which slug? extend existing or
# write new?), so this should be a reasoning-capable model — not a small/fast one.
model: smart
---

# File this memory

A piece of information arrived. Decide where in the wiki it belongs and write it there.

The content to file:

> {{prompt}}

Procedure:

1. Read `skills/memory/SKILL.md` once if you haven't already this run. It defines the
   wiki layout (people / threads / places), the wikilink convention, and the style
   rules.
2. Use `memory_search` to find existing notes that overlap with this content. Search for
   any names, projects, places, or distinctive nouns in the content.
3. If a matching file exists, **read it first**, then extend it with the new fact. Don't
   duplicate what's already there.
4. If no matching file exists, create one with a kebab-case slug in the right folder
   (`wiki/people/<slug>.md`, `wiki/threads/<slug>.md`, etc.). Cross-link related notes
   with `[[other-slug]]`.
5. Keep it terse: bullet points, not prose. Date facts when the date matters.
6. Cleanup if necessary - simplify, rename, merge, fix typos. The wiki is your baby; take care of it.

## Your output

Reply with a one-line summary of what you did (`extended wiki/people/alice.md`,
`created wiki/threads/acme-rollout.md`, or `noop — already recorded`).
