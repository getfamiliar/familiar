---
outputChat: false
model: fast
tools: core, fs, bash, whatsapp
---

A WhatsApp group message has arrived. We keep digest files for each subscribed group chat. Your job is to:

* register the group if not already registered
* determine if the group is subscribed or not
* add the message to the appropriate digest file
* only for subscribed groups: mark the message as read on WhatsApp

## Registering the group

We keep a list of all registered groups in `files/whatsapp-groups/grouplist.jsonl`. Read the `listfiles` skill to learn about the format if necessary. Each line in the file is a JSON object containing the keys "jid", "name", "group_code", "group_member_count" and "subscribed". If a field is missing in the current object, update it.

**NEVER** let a list entry span more than one line — no linebreaks inside the JSON objects, and always end the line with `\n`.

If the group is not registered yet, add it to the list with "subscribed" set to "true" and send the user a new `send_chat` message informing them about the newly discovered group ("FYI: I just discovered the new WhatsApp group 'X' and subscribed to it.").

## Subscribed or not?

To find out if subscribed or not, read the group list file `files/whatsapp-groups/grouplist.jsonl` and search for the JID of the incoming message's group. If "subscribed" is set to "false", still write the message to the unsubscribed digest file (see below) but do not mark it as read.

## Adding the message to the digest file

We keep two central digest files that are flushed after they were used. Each line in the files is a JSON object that contains the full payload of the message event.

* `files/whatsapp-groups/digest-subscribed.jsonl` for subscribed groups
* `files/whatsapp-groups/digest-unsubscribed.jsonl` for unsubscribed groups

So, your job is only to append the payload you received as a non-linebreak JSON object to the correct digest file. Obviously, if the digest file does not exist yet, create it. *ALWAYS* append with a closing linebreak `\n`, so that the next message can be appended as a new line! **NEVER** let an entry span more than one line — no linebreaks inside the JSON object.

The flush of these files regularly eats the closing linebreak of the last line, and parallel handler runs can concatenate two records onto one line. Before appending, make sure the file ends with `\n` (append a lone `\n` first if it doesn't). Afterwards validate every line with `json.loads` (bash tool, Python). If a line fails because two records were glued together (`}{`), split it into two lines at that point and write the file back; drop a line only if it is an unrecoverable fragment, and say so in your output.

## Only for subscribed groups: Marking the message as read

**Only for subscribed groups:** After you have successfully appended the message to the digest file, call `whatsapp_mark_read` so the message stops showing up as unread on the user's phone. Only call it after the digest write succeeded — if the write failed, leave the message unread so it shows up again next time.

For unsubscribed groups, do not mark anything as read: the user should still see the message in WhatsApp themselves.

## Your output

Your output text should be a concise text that explains what you did. It is only stored in the audit trail, not sent to the user.
