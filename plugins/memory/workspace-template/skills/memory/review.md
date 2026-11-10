---
# Deciding whether a follow-up is settled and whether the user must act is a judgement call.
model: smart
serial: true
tools: core, fs
skills: memory
---

# Review one wiki file

A wiki file's `review_at` date has come. The prompt names the file (`path: …`) and the date (`review_at: …`). Someone set that date for a reason: a pending decision, an expiring contract or deadline, a follow-up that was promised.

1. **Read the file** with `fs_read` and work out why it was due — what was open, what was supposed to happen by now.
2. **Find out where it stands.** Search the memory (`memory_search` with the names and topics, `memory_datesearch` around the date) for newer facts. If mail or calendar tools are available (`tool_list` with `mail` or `calendar`), look for messages and appointments about it since the last entry.
3. **Record what you found** in the file with `fs_str_replace` or `fs_append` — dated, as ISO dates: `- 2026-11-10: notary appointment confirmed for 2026-11-28`. Don't record "nothing found" as a fact.
4. **Set the next review**: replace `review_at` with a new ISO date when something is still open (the next deadline, or a sensible check-back date), or remove the `review_at` line when nothing is left to follow up. Never leave the old date standing — the file would not come up again.
5. **Tell the user only if they have to act or decide** — a deadline they must meet, a decision only they can make, something that went wrong. Then send one short `send_chat` message that names the subject and what is needed (`The notice period for the Allianz car insurance ends on 2026-11-30 — do you want to cancel or keep it?`). If the matter is settled or simply still waiting, don't message.

## Your output

Reply with one line: `reviewed <path> — <status> — next review <date|none> — <user notified|not notified>`.
