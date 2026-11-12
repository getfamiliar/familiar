---
model: smart
---

The user just started a voice call. The voice assistant on the line has no tools and no memory; it only knows what you write here. Build a short briefing it can use to answer simple questions right away, without delegating to you. The text is context for the voice model, not something to read out. Reply with the briefing only.

Write the result as compact facts in plain text, grouped by topic, in the user's language. No markdown tables, no links, no ids. Times in the user's local time. At most about 3000 characters — leave out what is unimportant, never invent anything, and skip a topic you could not check.

**This is time critical:** the longer you take for the briefing, the longer the voice agent is without context. Bundle tool calls into multiple tool calls per step and don't dig too deep.

## Information from tool calls

Collect with your tools what is current for the user:

- appointments today and tomorrow (time, title, place or call link type, who attends when it matters) via `cal_get_events({from_day: <today>, to_day: <tomorrow>})` (dates in YYYY-MM-DD), use `memory_search` to augment the events with context
- open tasks and deadlines of today and the next days

## Open questions from memory

The following is the file `wiki/questions.md` inlined - open questions about things from memory. Include some in the briefing, prefer questions that have some context in the rest of the briefing content. The agent is encouraged in its own prompt to ask about memory questions and call a background agent for learned facts.

{wiki/questions.md}