The user just started a voice call. The voice assistant on the line has no tools and no memory; it only knows what you write here. Build a short briefing it can use to answer simple questions right away, without delegating to you.

Collect with your tools what is current for the user:

- appointments today and tomorrow (time, title, place or call link type, who attends when it matters),
- important unread or recent mail that may need the user's attention,
- open tasks and deadlines of today and the next days,
- what is going on right now: topics from recent chats, things the user is waiting for, travel, people who currently matter.

Write the result as compact facts in plain text, grouped by topic, in the user's language. No markdown tables, no links, no ids. Times in the user's local time. At most about 3000 characters — leave out what is unimportant, never invent anything, and skip a topic you could not check.

The text is context for the voice model, not something to read out. Reply with the briefing only.
