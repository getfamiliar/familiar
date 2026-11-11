---
# Deciding what to condense and where a sub-thread belongs is a judgement call.
model: smart
serial: true
tools: core, fs, bash
skills: memory
---

# Shrink one oversized wiki file

A wiki file has grown beyond the size limit. The prompt names the file (`path: …`), its size and the limit in bytes. Bring it **well below the limit — aim for about two thirds of it** — without losing anything that still matters.

If the file is still over the limit when you are done, the harness cuts it mechanically in two halves (`<slug>.md` and `<slug>-2.md`). That keeps it readable but is a poor split, so do the job properly.

## How to shrink it

Read the file with `fs_read` first. It is large, so `fs_read` returns it in chunks: the header of the first one names the total size (`<file: …, bytes 1-B of TOTAL, truncated>`). **Request all remaining chunks at once** — several `fs_read` calls with their offsets (`B + 1`, `2B + 1`, …) in the same step — instead of one chunk per step; your steps are limited and you need them for the actual work.

Files usually grow for one of these reasons — check them in this order:

1. **It is a log instead of knowledge.** Mail and event ids, "archived / trashed / digest", "verified via API", duplicate deliveries, re-syncs, one "Addendum" or "Status (date)" section per message. Condense it to the facts as the section "What belongs in the memory" of the preloaded skill describes: the current state, the decisions, the dates that still matter, the outcome of settled matters. This is almost always the biggest win — do it first.
2. **A person or self file carries a whole thread.** A renovation, a project, a trip, a company's subscriptions inside `people/…` or `self/…`: move it into its own file under `wiki/threads/` with frontmatter, h1 and description, and leave one line with a wikilink in the original (`- Kitchen renovation 2026: see [[threads/kitchen-renovation-2026]]`).
3. **A thread holds several threads.** A summer camp inside the sports club's thread, a finished migration inside the product's thread: split it into separate thread files, each with its own frontmatter, h1 and description, linked to each other. If at least four threads now share one topic, they may go into a thread cluster folder (see "Thread clusters" in the skill) — but only then.

Write new files with `fs_write`; change the original with `fs_str_replace` (or rewrite it with `fs_write` once it is read and condensed — this run is the only one working on it). Keep every fact that still matters; keep the dates ISO.

## Fix every reference

When you move content to a new file, nothing has to change for links to the original. But when you **rename, move or delete** a file, every wikilink to it must follow. Find and rewrite them with `bash`, from the workspace root:

```bash
# who links to threads/summer-camp? (with or without alias)
grep -rnE '\[\[threads/summer-camp(\||\]\])' wiki/
# rewrite them to the new path, keeping aliases
grep -rlZE '\[\[threads/summer-camp(\||\]\])' wiki/ | xargs -0 -r sed -i -E 's#\[\[threads/summer-camp(\||\]\])#[[threads/sports-club/summer-camp-2026\1#g'
```

Run the `grep` again afterwards: it must find nothing.

## Your output

Reply with one line: `shrunk <path> <old> → <new> bytes — <what you did>` (e.g. `condensed the delivery log, moved the summer camp to threads/sports-club-summer-camp-2026.md`).
