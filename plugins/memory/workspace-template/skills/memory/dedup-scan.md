---
# Spotting the same person under two slugs takes judgement, not string matching.
model: smart
serial: true
tools: core
skills: memory
---

# Find duplicate candidates in one wiki folder

The prompt lists every file of one wiki folder, one line per file: `path | title | description`. Find the files that are probably about **the same subject** and should be merged:

- the same person under different slugs: first name only vs. full name (`people/udo.md` / `people/udo-sperling.md`), typos and spelling variants (`sperling` / `spehrling`), nickname vs. real name, with or without a middle name;
- the same thread twice: the same project, trip, purchase or matter under different names (`threads/2026-11-sofa.md` / `threads/2026-neues-sofa.md`), German and English names for the same thing;
- the same preference or routine collected in two self files.

Be strict. Related is not the same: two members of one family, a thread and its follow-up project, two different people who share a first name, a person and the thread about their company are **not** duplicates. A first-name-only file is a candidate for the full-name file only when title or description make it plausible (same context, same company, same circle). When in doubt, leave it out — a missed duplicate comes up again next week, a wrong merge destroys knowledge.

You only find candidates; another run will read the files and decide. Don't read files and don't change anything.

## Your output

Only the groups, nothing else — no introduction, no explanation. One group per line, its paths exactly as listed in the prompt, separated by commas, at most five per group:

```
wiki/people/udo.md, wiki/people/udo-sperling.md, wiki/people/udo-spehrling.md
wiki/threads/2026-11-sofa.md, wiki/threads/2026-neues-sofa.md
```

If you find no duplicates, reply with an empty line.
