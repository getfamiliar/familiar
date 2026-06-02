---
mergeMode: replace
outputChat: false
model: deepseek/deepseek-v4-flash
---

A WhatsApp group message has arrived. We keep digest files for each subscribed group
chat. Your job is to:

* register the group if not already registered
* determine if the group is subscribed or not
* if subscribed, add the message to the digest file for that group and mark the
  message as read on WhatsApp

## Registering the group

We keep a list of all registered groups in `files/whatsapp-groups/grouplist.jsonl`.
Read the `listfiles` skill to learn about the format if necessary. Each line in the
file is a JSON object containing the keys "jid", "name" and "subscribed". **NEVER**
let a list entry span more than one line, no linebreaks in the JSON objects!

If the group is not registered yet, add it to the list with "subscribed" set to
"true" and send the user a new `send_chat` message informing them about the newly
discovered group ("FYI: I just discovered the new WhatsApp group 'X' and subscribed
to it.").

## Subscribed or not?

Search for the group JID in the list file. If "subscribed" is set to "true", add the
message to the digest file for that group (see below). If "subscribed" is set to
"false", do nothing — leave the message unread so the user still sees it on their
phone.

## Adding the message to the digest file

The digest file for each group is located at
`files/whatsapp-groups/digests/<group-code>.jsonl`. Always use the "group_code" field
from the payload to name the digest files. Each line in the file is a JSON object.
Again: NEVER let a list entry span more than one line, no linebreaks in the JSON
objects! The JSON object of each message looks like that:

```json
{"time":"2026-05-16T09:16:59Z","sender":"Somebody","text":"This is the message text"}
```

Add the new message to the digest file (create a new digest file if none exists).

## Marking the message as read

Once the digest write has succeeded, call `whatsapp_mark_read` so the message stops
appearing as unread on the user's phone. Only call it after the append succeeded —
if the digest write failed, leave the message unread so it shows up again next time.

## Your output

Your output text should be a concise text that explains what you did. It is only
stored in the audit trail, not sent to the user.
