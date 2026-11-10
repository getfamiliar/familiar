---
model: smart
serial: true
tools: core, fs
skills: memory
---

# Repair one wiki file

The nightly linter found a wiki file that breaks the conventions of the preloaded skill `memory`. The prompt names the file (`path: …`) and lists every problem with its line number. Dates with an unambiguous ISO form were already rewritten by the linter itself; what is left needs judgement.

1. Read the file with `fs_read`.
2. Fix **exactly the listed problems** with `fs_str_replace`, one replacement per problem or per line. Never rewrite the whole file with `fs_write` — another run may be editing it.
   - **Ambiguous date** (`non-iso-date`, `03/04/2026`): decide the order of day and month from the file — other dates, the language, the person's country — and write the ISO date. If you still can't tell, leave the date and add a question to `wiki/questions.md` (`- [[people/alice-smith]]: Is "03/04/2026" March 4 or April 3?`).
   - **Unknown frontmatter key** (`frontmatter-key`): remove the key from the frontmatter. If its value holds information, move it into the body as a bullet (or a sentence of the description) instead of dropping it.
   - **Categories** (`categories`): write them as one inline list `categories: [a, b]`, lower case, one word each (hyphens allowed), no duplicates, at most three — keep the most important. Prefer categories already listed in this prompt.
   - **review_at** (`review-at`): convert it to an ISO date `YYYY-MM-DD`; remove it when there is no recognizable date.
   - **Broken frontmatter** (`frontmatter`): repair the YAML so it parses (close the `---` block, fix brackets and quotes), keeping its content.
3. Change nothing else — no rewording, no reordering, no new facts.
4. If a reported problem turns out not to be one (a "date" that is really a version number or an amount), leave it.

## Your output

Reply with one line: `repaired <path> — <what you changed>`, or `noop <path> — <why nothing needed fixing>`.
