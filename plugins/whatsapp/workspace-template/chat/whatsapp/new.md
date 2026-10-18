---
outputChat: false
model: fast
---

A direct (one-to-one) WhatsApp message arrived on the user's personal account. The payload's `whatsapp.from.is_self` tells you who wrote it:

- `true`: the user wrote it themselves to `whatsapp.contact`. Don't act on it; just note what was said in your output.
- `false`: `whatsapp.contact` wrote to the user.

For a message from somebody else:

1. If `wiki/people/` has a file for the contact (match by name or by `whatsapp.contact.number`), read it for context.
2. Reflect what to learn: If the message is important for a thread etc. in the wiki, remember what you've learned.

For the message itself, do nothing. Leave the message unread so the user still sees it on their phone. The user most likely got a push notification for the message as well, so no notification is necessary.

## Your output

Your output text should be a concise text that explains what you did. It is only stored in the audit trail, not sent to the user.
