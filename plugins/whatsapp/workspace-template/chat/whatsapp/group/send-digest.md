---
cron: at 18:00
outputChat: false
model: smart
maxOutputTokens: 32000
tools: core, fs
---

Send the user a digest of today's WhatsApp group messages.

1. You can find all WhatsApp group messages from subscribed groups since the last digest at `files/whatsapp-groups/digest-subscribed.jsonl`. If the file doesn't exist or is empty, there is nothing to send: reply with a one-line "no group messages since the last digest" and stop.
2. Read the digest file and create a nice digest for the user (see below).
3. After you have successfully read the digest file, remove it. A new file will be created on the first new group message for the next digest.

## Your output

After you have prepared the digest, send it to the user using `send_chat`. Do not include "Now I have everything I need" or similar phrases — deliver ONLY the digest content.

After sending the digest, proceed with the reflection. Your final response (not sent to the user) should be a short processing summary of what you did.

Follow the following rules for the digest:

* The file you process is raw data - all group messages of the day. Your job is to decide what is relevant enough to reach the users attention!
* Group by chat group and mention the full name of the group as a header.
* Group messages by discussion threads and summarize the whole discussion ("Alice and Bob discussed AI tools for bookkeeping with tool X as the clear recommendation from Bob. 5 others agreed with Bob.")
* Only include messages and discussions that are relevant for the user to read (see below for examples of irrelevant messages)!
* If our user has been mentioned in a message or discussion or got an answer to an own message, prioritize including it in the digest.

### Irrelevant topics

Our user does not care about the following things, DO NOT include them:

* Local offers and searches far from where the user lives (see "About your user" and the wiki): office space, real estate, craftsmen, a tax consultant, a lawyer or a wedding venue in another city — skip them. When you don't know where the user lives, keep them.
* Uncommented links to newspaper or magazine articles
* Open questions without answers the user likely cannot help with

## Reflection

Reflect two aspects:

* "Is there something I learned from the messages my user has sent themself that is worth remembering for the long term?" - it's likely that the user has shared some personal preferences or searches for help with a new project.
* "Is there something I learned about people our user has a relationship with that is worth remembering for the long term?" - if somebody we have a relationship with writes a message about something they search / need / have done / like, we want to remember it in their person file in the wiki.

**No new personal relationships from huge groups:** Check the `group_member_count` field to find out about the size of the groups in the digest. Do NOT assume a relation to other people in groups with more than 15 members, those are more like public marketplaces. In those huge groups, only process people we already know or that explicitly interacted with us.

For every learning worth remembering: Summarize the learning and call `memory_save` to save it. **IMPORTANT**: In case of doubt, rather remember a little too much than too little. Let the tool call sort it out!
