---
# Revisiting a memory in the light of everything related to it is a judgement call.
model: smart
serial: true
tools: core, fs, bash
skills: memory
---

# Dream about one memory

At night you revisit a few memories, the way sleep consolidates what was learned during the day. The prompt names one wiki file (`path: …`), its size, and why it was picked (`selected because: …`). Make this memory — and the memories around it — better: more accurate, more connected, more compact. You decide what that takes.

## Why it was picked

- **changed** — the file is new or grew since its last dream. Integrate the new content: does it fit the file, does it repeat or contradict what is there, does it belong somewhere else, does it change the current state at the top?
- **hot** — agent runs read it a lot. It has to be right and easy to use: a precise title and description, the current state first, no stale facts.
- **cold** — nobody changed or read it for a long time. Is it still relevant? Condense it to what will still matter, merge it into a related file, or delete it.
- **oldest** / **random** — a general review.

## How to dream

1. **Read the file** with `fs_read`. If the first chunk's header says `truncated`, request all remaining chunks at once — several `fs_read` calls with their offsets in the same step.
2. **Find its cluster** with `memory_search`: the names, places, companies and topics in the file as separate terms, plus synonyms and its categories. Read the files that are really about the same people or matters.
3. **Improve what you find**, in this file and its cluster:
   - condense process logs and overtaken status sections to the facts (see "What belongs in the memory" in the preloaded skill);
   - update facts that related files show to be outdated, and carry new facts to the file they belong to;
   - merge files that turn out to be about the same subject;
   - add wikilinks between files that belong together;
   - sharpen title, description and categories so a search finds the file;
   - set `review_at` for a matter that is still open and needs a follow-up, remove it when nothing is left to follow up;
   - add a question to `wiki/questions.md` when something stays unclear.
4. **Delete the file** when nothing in it would still be useful in three months — a settled one-off matter, an empty shell, a duplicate whose facts now live elsewhere.

Never invent facts; only rearrange, condense, connect and correct what the wiki already knows. Change files with `fs_str_replace` or rewrite them once with `fs_write` after reading them completely.

## Fix every reference

When you **rename, merge away or delete** a file, every wikilink to it must follow. Find and rewrite them with `bash`, from the workspace root:

```bash
# who links to people/jordan? (with or without alias)
grep -rnE '\[\[people/jordan(\||\]\])' wiki/
# point them to the new file, keeping aliases (when deleting: remove or rewrite those lines instead)
grep -rlZE '\[\[people/jordan(\||\]\])' wiki/ | xargs -0 -r sed -i -E 's#\[\[people/jordan(\||\]\])#[[people/jordan-miller\1#g'
```

Run the `grep` again afterwards: it must find nothing. Also check `wiki/questions.md` for bullets about the file.

## Your output

A short summary of what you did. The first line is a one-line headline — it goes into the commit message (`condensed the renovation log, merged people/jordan.md into people/jordan-miller.md`, or `nothing to improve`). Then, if there was more, one bullet per change.
