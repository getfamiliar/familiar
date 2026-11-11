---
# Merging two memories or telling them apart is a judgement call.
model: smart
serial: true
tools: core, fs, bash
skills: memory
---

# Merge or tell apart possible duplicates

A scan of the wiki found files that may be about the same subject. The prompt lists them and, when they are small enough, includes their content (`<file path="…">`); otherwise read them with `fs_read`.

## Decide

For every pair of files: is it really the same person, thread or preference? Look at names, places, companies, people around them, dates. Don't trust the slug alone.

- **Same subject** → merge them (below).
- **Different subjects** → leave both. If the title or description made them look alike, sharpen them so a later reader tells them apart (`# Udo Sperling` + "Neighbour in the village …" vs. `# Udo Kraus` + "Colleague at Acme …").
- **Can't tell** → leave both and add a question to `wiki/questions.md`: `- [[people/udo]] / [[people/udo-sperling]]: Same person?`.

## Merge

1. Pick the file to keep: the one with the most identifying slug (full name beats first name) — usually also the more complete one. If the best slug is a new one (`udo-sperling.md` when both files are `udo.md` and `sperling.md`), create it.
2. Move every fact from the other files into it, under the fitting headings. Don't duplicate what is there already; where facts contradict, keep the newer one and note the doubt (`- (unclear) …`). Write the merged result once with `fs_write` — this run is the only one working on these files.
3. Combine the frontmatter: at most three categories, the earlier `review_at`.
4. Delete the merged-away files with `bash` (`rm wiki/people/udo.md`).
5. Rewrite every wikilink to a deleted file to the kept file, keeping aliases — from the workspace root:

```bash
# find links to the merged-away file (with or without alias)
grep -rnE '\[\[people/udo(\||\]\])' wiki/
# point them to the kept file
grep -rlZE '\[\[people/udo(\||\]\])' wiki/ | xargs -0 -r sed -i -E 's#\[\[people/udo(\||\]\])#[[people/udo-sperling\1#g'
```

Run the `grep` again afterwards: it must find nothing. Also check `wiki/questions.md` for bullets about the merged files.

## Your output

Reply with one line: `merged <files> into <file>`, `kept apart <files> — <why>` or `unclear <files> — question added`.
