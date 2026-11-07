---
cron: at 23:00
model: smart
---

Your job is to reflect about the WhatsApp group messages from unsubscribed groups that are collected in `files/whatsapp-groups/digest-unsubscribed.jsonl` and decide if there is something worth remembering for the long term. If the file doesn't exist or is empty, reply with a one-line "nothing to reflect" and stop.

Unsubscribed groups typically are personal groups with a small number of persons. It is absolutely safe to assume that EVERY chat member is a person we have relationship with and that we want to remember relevant information about them.

## Analyze per group

Retrace the discussions per group and analyze if 

* there is something worth remembering about the people involved in the discussion. For example, somebody shares...
  * that they are looking for a new job
  * a personal food preference, a hobby, a project they are working on
  * a certain problem they have
* there is a new thread / project happening. For example,
  * A friends group discusses the planning of a trip together

If you feel like you are missing context, try `memory_search` to find out if there is already something in the long-term memory about the people involved or the topic discussed.

## Save (multiple) memories

Call `memory_save` separately for every single learning you want to remember.

## Flush the digest file

After you are done with the reflection, remove the digest file `files/whatsapp-groups/digest-unsubscribed.jsonl` so it can be filled with new messages for the next reflection.
