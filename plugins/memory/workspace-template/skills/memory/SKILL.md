---
name: memory
description: How the agent's long-term memory is organized.
tools: memory
---

# The wiki

Long-term memory lives in markdown under `wiki/`. Every `.md` file in the workspace is indexed and searchable via `memory_search`, but the wiki is where memories the agent creates deliberately land.

## Folder and file structure

- `wiki/people/<slug>.md` — one file per person. Facts about who they are, your relationship, preferences, recent interactions. The preferred slug is their full name.
- `wiki/threads/<slug>.md` — one file per ongoing topic, project or conversation that spans more than a single event. Examples are "acme-rollout", "budget-2025", "alice-school".
- `wiki/self/<slug>.md` - facts about our user themself, their preferences, routines, important events in their life.
- `wiki/journal/YYYY-MM.md` - a monthly journal of events, meetings, and notes.
- `wiki/places/<slug>.md` — one file per recurring location (homes, offices, regular venues, addresses).

Other folders can grow under `wiki/` as the need surfaces — invent a folder when an existing one feels wrong.

### Slugs

Filenames are kebab-case slugs: `alice-smith.md`, `acme-rollout.md`, `office-berlin.md`. Use the most identifying name available — a person's full name beats their first name.

## How chunking works

A memory file is **not** indexed as one big blob. The indexer splits each file on every heading at level `#`, `##` and `###` and treats each section as its own memory chunk. A search hit returns the matching chunk together with its headline trail (`# Alice Smith > ## Meetings > ### Atlanta 2026-05-12`), so the structure of the file directly shapes how memories are addressable.

## How to structure wiki files

1. Start each file with a h1 heading with the name of the subject (`# Alice Smith`, `# Acme Rollout`, `# Berlin Office`).
2. The first thing after the headline has to be a plain paragraph. It is the file-wide context, which is prepended to every chunk for search and retrieval. Use it to summarize in one sentence what this file is about.
3. Use h2 and h3 headings to break the file into distinct facts or episodes. Each section becomes a separate chunk in the index, so use headings to mark natural memory boundaries: a new meeting, a new decision, a new fact about a different relationship. Don't pile everything under one heading; the search engine can't tell them apart.
4. Headings h4+ don't create new chunks but stay within their parent chunk, so use them for structure within a memory, not to mark new memories.
5. Keep each section self-contained enough that someone reading it without seeing the headline trail still roughly understands what it's about.

```markdown
# Adam Smith

Senior PM at Acme; primary contact for the GTM workstream. Based in Atlanta.

## Meetings
...
```

If the file leads with a list, sub-heading, or code fence directly under the h1, the context is empty and every chunk loses that document-wide framing. So: always write that one-line description right under the h1.

### Wikilinks

Cross-link liberally: `[[people/alice-smith]]`, `[[threads/acme-rollout]]`. Wikilinks are plain markdown for now (no resolver) but they signal connection to future readers and add useful co-occurrence signal to the index. The path is relative to `wiki/` and excludes the `.md` suffix: `[[people/alice-smith]]`, not `[[wiki/people/alice-smith.md]]`.

### Style

- **Bullet points over prose.** Memories are reference material, not essays.
- **Date facts when the date matters.** Use absolute dates the reader can interpret without context: `- 2026-05-22: signed the NDA`.
- **Don't repeat what's already there.** Your job is to add, not duplicate. If the same fact is already recorded, leave the file alone.
- **Note uncertainty.** If something is a guess, mark it: `- (probably) lives in Berlin`.

**Important**: Always write dates in the format `YYYY-MM-DD` so they can easily be searched and understood. A search for "-07-12" should find all facts related to July 12th, regardless of the year.

## Read-before-write discipline

Before writing a new memory, **always** run `memory_search` for the subject. If a file already exists, extend it rather than creating a parallel one. Only create a new file when no good home exists for the new fact.

If you modify an existing memory file, do **NOT** use `fs_write` to overwrite the whole file as this might overwrite changes from other agent runs. Instead, use `fs_str_replace` or `fs_append` to add new facts without losing existing ones.

## Interpreting calendar events

For calendar events, the fact that our user is the creator / organizer of an event in their own calendar does not mean that they are the real organizer of the event. It's perfectly normal to create calendar events for things organized by others. Do NOT assume that they are the organizer unless other people are invited as well.

## Cleanup discipline

You are in charge of the wiki's quality. If you find duplicate files, merge them. If you find outdated facts, update them. If you find typos, fix them. The wiki is your baby; take care of it.

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
