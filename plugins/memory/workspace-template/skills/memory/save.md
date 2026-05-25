---
tools: file_read, file_write, memory_search
# Recommended: pin a reasoning-capable model here. Filing a memory is a
# judgement call (which folder? which slug? extend existing or write new?),
# and a small/fast model will drop facts on the floor. Uncomment one of:
# model: deepseek/deepseek-reasoner
# model: anthropic/claude-opus-4-7
# model: openai/o1
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

Reply with a one-line summary of what you did (`extended wiki/people/alice.md`,
`created wiki/threads/acme-rollout.md`, or `noop — already recorded`).
