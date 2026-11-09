---
name: memory
description: How the agent's long-term memory is organized.
tools: memory
---

# The wiki

Long-term memory lives in markdown under `wiki/`. Every `.md` file there is indexed and searchable via `memory_search` (terms) and `memory_datesearch` (dates); files outside `wiki/` are not part of the memory.

## Folder and file structure

- `wiki/people/<slug>.md` — one file per person. Facts about who they are, your relationship, preferences, recent interactions. The preferred slug is their full name.
- `wiki/threads/<slug>.md` — one file per ongoing topic, project or conversation that spans more than a single event. Examples are "acme-rollout", "budget-2025", "alice-school".
- `wiki/self/<slug>.md` - facts about our user themself, their preferences, routines, important events in their life.
- `wiki/journal/YYYY-MM.md` - a monthly journal of events, meetings, and notes.
- `wiki/places/<slug>.md` — one file per recurring location (homes, offices, regular venues, addresses).

Other folders can grow under `wiki/` as the need surfaces — invent a folder when an existing one feels wrong.

### Slugs

Filenames are kebab-case slugs: `alice-smith.md`, `acme-rollout.md`, `office-berlin.md`. Use the most identifying name available — a person's full name beats their first name.

## How the memory is searched

The search is deliberately simple and literal — **you** do the thinking:

- `memory_search` takes 1–8 terms (OR) and matches them, tolerating small typos, against each file's title (the h1), its description (the paragraph under the h1), its categories, its headings and every line of text. Files matching more terms rank first. The result is a table of files with the best matching line; read the files you need with `fs_read`.
- There is no semantic matching. Searching `Steuerberater` does not find `tax advisor` or `Buchhaltung` — send synonyms, related words and both languages yourself: `["Steuerberater", "Steuerberatung", "tax advisor"]`.
- The categories listed in the prompt are search terms too: a category lists a whole set of files, e.g. every property or every insurance, even when the files don't spell out the word.
- `memory_datesearch` lists every line with an ISO date in a range (`from` / `to`) or on a day of the year (`day: "07-12"`). This only works because every date is written as an ISO date (see below).

Matches are literal, too: the `Matched` column shows how many of your terms a file contains, and a file that only shares a first name or a generic word is not about your subject. When no file is really about it, the memory doesn't know it — say so instead of citing loosely related files.

So a file is only findable through the words it contains. Write titles and descriptions with the concrete names, places and counterparts a later search would use.

## How to structure wiki files

1. Start the file with a frontmatter block holding its `categories`, if one fits (see below).
2. Then an h1 heading with the name of the subject (`# Alice Smith`, `# Acme Rollout`, `# Berlin Office`). This is the file's **title**: name the entity, not the category (`# Alte Mühle Unterbrunn`, not `# Immobilie`).
3. The first thing after the h1 has to be a plain paragraph: the file's **description**, one sentence of at most ~160 characters that names the concrete people, places and counterparts (`Sale of the inherited house "Alte Mühle" in Unterbrunn via broker Ralf Szymanski; notary date pending.`). It is shown in every search result, so it decides whether a later reader opens the file.
4. Use h2 and h3 headings to break the file into distinct facts or episodes: a new meeting, a new decision, a new fact about a different relationship. Headings are searched with a higher weight than plain lines and show up as the context of a matching line.
5. Keep each section self-contained enough that someone reading it without the heading still roughly understands what it's about.

```markdown
---
categories: [clients, work]
---
# Adam Smith

Senior PM at Acme; primary contact for the GTM workstream. Based in Atlanta.

## Meetings
...
```

If the file leads with a list, sub-heading, or code fence directly under the h1, the description is empty and search results show nothing about the file. So: always write that one-line description right under the h1.

### Frontmatter

Only two fields, both optional, nothing else:

- `categories`: 0–3 lower-case words, most important first, e.g. `[property, inheritance]`. A category names a **set someone would ask for as a whole** ("which properties do I have?", "who is in the EO?"), using the word such a question contains. **Reuse the categories listed in the prompt.** Add one only when the file really belongs to such a set; a file with no fitting category gets none — never file it under a vague catch-all (`misc`, `culture`, `services`). Invent a new category only for a new set of several files that will grow, never for a single file.
- `review_at`: an ISO date (`2026-11-20`) when the file should be looked at again — a pending decision, an expiring contract, a follow-up. Leave it out for files that don't need a follow-up.

### Wikilinks

Cross-link liberally: `[[people/alice-smith]]`, `[[threads/acme-rollout]]`. Wikilinks are plain markdown for now (no resolver) but they signal connection to future readers and add useful co-occurrence signal to the index. The path is relative to `wiki/` and excludes the `.md` suffix: `[[people/alice-smith]]`, not `[[wiki/people/alice-smith.md]]`.

### Style

- **Bullet points over prose.** Memories are reference material, not essays.
- **Date facts when the date matters.** Use absolute dates the reader can interpret without context: `- 2026-05-22: signed the NDA`.
- **Don't repeat what's already there.** Your job is to add, not duplicate. If the same fact is already recorded, leave the file alone.
- **Note uncertainty.** If something is a guess, mark it: `- (probably) lives in Berlin`.

### Dates: ISO 8601 only

**Every date in a memory file must be an ISO date, `YYYY-MM-DD`.** Never write `12.07.2026`, `07/12/2026`, `12. Juli 2026` or `July 12, 2026` — not in bullets, not in headings, not in prose. Convert dates from mails, chats and calendar entries before writing them down. Consistent ISO dates are what makes them searchable: `memory_datesearch` with `day: "07-12"` finds every fact on a July 12th in any year, and `from: 2026-07-01, to: 2026-07-31` finds the whole month.

A time of day is optional. When it matters, add it after the date as `HH:MM` (24-hour clock, local time): `2026-07-12 14:30`.

```markdown
- 2026-07-12: signed the NDA
- 2026-07-12 14:30: call with Alice about the rollout
## 2026-07-12: Dinner with the Smiths
```

When only the month or year is known, shorten the ISO form: `2026-07` or `2026`.

## Read-before-write discipline

Before writing a new memory, **always** run `memory_search` for the subject — with its names, synonyms and categories as separate terms. If a file already exists, extend it rather than creating a parallel one. Only create a new file when no good home exists for the new fact.

If you modify an existing memory file, do **NOT** use `fs_write` to overwrite the whole file as this might overwrite changes from other agent runs. Instead, use `fs_str_replace` or `fs_append` to add new facts without losing existing ones.

## Interpreting calendar events

For calendar events, the fact that our user is the creator / organizer of an event in their own calendar does not mean that they are the real organizer of the event. It's perfectly normal to create calendar events for things organized by others. Do NOT assume that they are the organizer unless other people are invited as well.

## Cleanup discipline

You are in charge of the wiki's quality. If you find duplicate files, merge them. If you find outdated facts, update them. If you find typos, fix them. The wiki is your baby; take care of it.

Collect open questions about the wiki in `wiki/questions.md` — a person whose relationship to our user is unknown, a thread whose purpose is unclear, contradicting facts. One bullet per question with a wikilink: `- [[people/alice]]: How does the user know Alice?`. They are asked in a clarifying conversation with the user later; remove a bullet once the answer is recorded in the file.

If you find a slug that is misleading, too short or wrong, rename the file and update all links to it. Example: `wiki/people/alice.md` is too vague and you just learned her last name, so rename to `wiki/people/alice-smith.md` and update all links from `[[people/alice]]` to `[[people/alice-smith]]`.

## Content guidelines for the different folders

### People

The goal is to have a file for every person our user has a relationship with, from close family to distant acquaintances. The file should contain the key facts that define who this person is and what the relationship is about. Examples:

* Who is this person? What is your relationship?
* Where do they work and live?
* What are their preferences? ("Likes chocolate", "Hates seafood", "Fan of the local football club"...)
* Keep a list of events and meetings with this person, especially if they are important for the relationship ("2026-05-22: signed the NDA", "2026-06-15: had a fight about the budget", "2026-07-01: went to a football game together").
* Keep a list of needs and projects of the person we know about, but keep dates as these things tend to pass.
* If it is about a group of people rather than a single person, tend to put it in a thread file instead. Exception are families ("The Smith family lives in Stuttgart"). Prefix the file with "family-" (or the localized pendant).

Do NOT give people a file just because they did a cold outreach or sent an email. If our user does not interact with them / responds to them, they don't need a file. The typical LinkedIn contact request should be ignored.

### Threads

The goal is to have a file for every ongoing topic, project, or conversation that spans more than a single event. Examples are "acme-rollout", "budget-2025", "alice-school". The file should contain the key facts that define what this thread is about and what has happened in it. Examples:

* What is this thread about?
* Who is involved?
* What are the key events and decisions? Date them!
* What are the current status and next steps?

Examples for threads:

* A work project like "acme-rollout" that involves multiple people and meetings over time.
* Communication about the school class and curriculum of the users children
* A personal project like "home renovation" that involves multiple steps and decisions over time.
* All repairs and service appointments related to the user's car(s) - you should know when the tires were changed the last time.

If something is more a immutable preference of the user rather than a thread that evolves over time, it probably belongs in the self folder instead.

### Self

Extra space to remember facts about our user themself that are NOT related to a thread or another person. Examples:

* Food preferences
* Hobbies and interests
* Routines ("Goes to the gym every Tuesday and Thursday 17:30", "Always has coffee at 10am")
* TV shows and movies watched, cinema shows attended
* A timeline of important events in their life, collected in a file like `wiki/self/timeline.md` - "2022-05-22: started new job at Acme Corp", "2026-06-15: moved to Berlin", "2026-09-01: got a new dog".

Do NOT include things that belong in a thread or a person file. If a specific person or thread is involved, store things there.

### Places

One file per recurring location: homes, offices, regular venues, addresses. Keep what is useful to know when going there or planning around it — address, how to get in, who lives / works there, opening hours, regular visits.

### Journal

A place to record daily thoughts, reflections, and observations in a monthly journal file. This can include timebound events you want to remember but that are not important enough to be in a thread or person file. Examples:

* "2026-05-14: dinner with the Smiths at the new Italian place downtown — great pasta, slow service."
* "2026-05-20: first swim of the year in the lake."
* "2026-05-28: power outage in the evening, two hours without internet."

Write to `wiki/journal/YYYY-MM.md` with the title `# Journal YYYY-MM` and one `##` heading per entry, date first: `## 2026-05-14: Dinner with the Smiths`. Each entry becomes its own chunk. When an entry turns out to matter for a person or thread, record it there as well.
