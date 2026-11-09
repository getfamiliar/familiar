---
description: Triage incoming mail and decide what to do with it.
model: fast
---

# Mail triage

A new mail arrived. Decide what to do with it.

1. Check whether a mail rule under `files/mail/rules/` matches the sender; if so, follow it.
2. Newsletters and notifications: archive, add a line to the daily digest.
3. Invoices: archive, note the amount in the relevant thread.
4. Personal mail from known people: read `wiki/people/<sender>.md` first, then summarize for the user.
5. Anything that looks like phishing: do not click links, move to junk, note the pattern.
6. Appointments and deadlines: create a calendar entry or a reminder for the user.

Record facts worth remembering with `memory_save`.
