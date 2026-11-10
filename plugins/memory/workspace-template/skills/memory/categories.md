---
cron: every day at 04:00
# Judging whether categories are synonyms or useless is a judgement call.
model: smart
serial: true
tools: core, fs, bash
skills: memory
---

# Check the memory categories

Once a day, look at the categories of the wiki (listed with their file counts under "Memory" in this prompt) and keep them useful. A category is good when it names a **set someone would ask for as a whole** ("which properties do I have?") — see "Frontmatter" in the preloaded skill `memory`.

## What to look for

- **Synonyms and duplicates**: singular and plural (`property` / `properties`), German and English (`familie` / `family`), near-synonyms (`car` / `vehicle`). Merge them into the one that is used more or reads more naturally.
- **Catch-alls**: `misc`, `other`, `general`, `stuff`, `culture`, `services` — they don't name a set anyone asks for. Remove them.
- **Single-file categories** that won't grow into a set: remove them. Keep one that obviously will (a first `insurance` file).
- **Mismatched files**: when you look at the files of a category, one that clearly doesn't belong loses that category.

When you are not sure whether two categories mean the same set, leave them and add a question to `wiki/questions.md` instead.

## How to do it with `bash`

Categories always stand on one line as an inline list (`categories: [property, inheritance]`), so `grep` and `sed` are safe. Work from the workspace root; every command can cover many files at once, so you rarely need more than a few steps.

List the files of one or more categories with title and description:

```bash
for f in $(grep -rlE '^categories:.*\b(car|vehicle)\b' wiki/); do echo "== $f"; grep -m1 '^categories:' "$f"; grep -m1 -A2 '^# ' "$f"; done
```

Rename or merge `vehicle` into `car` in every file:

```bash
grep -rlZE '^categories:.*\bvehicle\b' wiki/ | xargs -0 -r sed -i -E '/^categories:/ s/\bvehicle\b/car/'
```

Remove `misc` everywhere (handles a single value and the first, middle and last list position):

```bash
grep -rlZE '^categories:.*\bmisc\b' wiki/ | xargs -0 -r sed -i -E '/^categories:/ { s/\[misc\]/[]/; s/: misc$/: []/; s/\bmisc, //; s/, misc\b// }'
```

Then check the result with `grep -rhE '^categories:' wiki/ | sort | uniq -c | sort -rn`. A merge can leave a category twice in one file (`[car, car]`); the nightly linter flags and repairs that, so you don't need to clean it up by hand.

Never touch anything but the `categories:` lines.

## Your output

Reply with one line: what you merged, renamed and removed (`merged vehicle → car (4 files), removed misc (2 files)`), or `noop — categories are fine`.
