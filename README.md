# Familiar

**Your personal AI assistant. Loyal. Local. Markdown.**

Familiar is an agent harness built to be your personal assistant. It focusses on the important things for personal assistants:

* **Focus on security.** A personal assistant needs access to the most sensitive data to be truly helpful. Familiar protects your data thoroughly:
  * the agent runs in a Docker container without internet access and never sees secrets like API keys or logins.
  * MCPs are also isolated in containers and can be set to run offline.
  * Fine-grained settings control access to sensitive functions.
* **Mails, Calendar, Cloud Storage, Messengers - what a personal assistant needs, out of the box.** Familiar can triage your mails, summarize your WhatsApp groups and store invoices from mails in your Sharepoint or OneDrive folders. It can even download your Tesla Supercharger invoices with the right plugin installed.
* **Designed to reliably do tedious tasks.** Create Standard Operating Procedures in plain and simple markdown files. Familiar will follow the SOPs for a certain event like "new mail arrived" - traceable, correctable, repeatable.


What's nice about it

Explain whole event-based system: events, handlers, etc.

Tools

Plugins emitting events

Architecture

MCP Integration

call tools add-mcp

* Prefered source: Docker MCP Registry, see
* Secondary: Official MCP Registry, see
* Custom: just go, remember the tools call-mcp command if necessary

# Familiar is not (only) a chat, it's an event processing engine

With Familiar, everything that happens in the world is an event. Even when you chat with it, each chat message is an event, just like a new incoming mail. There are two ways Familiar starts acting:

* An event happens. Most events are emitted by Familiar plugins. Plugins can monitor your mailbox or your WhatsApp account. Each event is processed by a handler file.
* A cronjob happens. You can schedule handlers to be executed on certain points in time. Perfect for your daily morning briefing or the monthly bookkeeping run.

## Handler files: Markdown files become your standard operating procedures

Events have topics - "chat:whatsapp:group" is the topic for new WhatsApp group messages, "mail:new:ms365" is the topic for new mails in your MS365 account. Each event starts a new session for the agent.

**Fixed handler file path per event topic.** For each event, there's a markdown file in your workspace that tells the agent what to do. We call it a "handler file". The topic defines where the file is - for the WhatsApp group message example, the file is `chat/whatsapp/group.md`. This file is included in the system prompt the agent receives.

**index.md in a folder is okay, too.** Instead of `chat/whatsapp/group.md`, you can also use `chat/whatsapp/group/index.md`. This is useful if you have other handlers dealing with WhatsApp group messages (like a daily digest) and want to keep them together in a folder. And for root topics like "chat", it has to be the `chat/index.md` file as no handlers are allowed in the root of the workspace.

**The most specific handler wins.** For the event topic "mail:new:ms365", Familiar first checks if `mail/new/ms365.md` exists. If not, it checks `mail/new.md` and then `mail/index.md`. This way, you could use the same handler `mail/new.md` for all incoming mails, regardless of where they come from.

## Cronjobs: Schedule work

You can create handler files that do not match an event topic and add a `cron:` statement in the file to schedule its execution. Thats's perfect for your daily morning briefing. For example, this handler creates a morning briefing and sends it via chat:

```md
---
cron: at 07:00
outputChat: true
---

Your job is to prepare a daily briefing for the user. The briefing should contain the following aspects:

* Todays calendar events
* Weather forecast for the day - home address usually, but consider todays event locations as well
* The Jira tickets for today
* The Whoop metrics for today (sleep, recovery, strain) and any relevant insights

If you determine that the user has to travel with the Tesla today, check the battery level with the tool `tesla_info` and include it in the briefing. If the battery is below 20%, include a warning and suggest charging it.

Combine all that to a motivating and inspiring briefing for the user to start their day.

...
```

## Cloud storage

The agent reads, searches and (optionally) writes cloud files through ten core `storage_*` tools (`storage_list_mounts`, `storage_list`, `storage_stat`, `storage_search`, `storage_download`, `storage_write`, `storage_mkdir`, `storage_move`, `storage_copy`, `storage_delete`). Providers are plugins; today `ms365` provides OneDrive and SharePoint document libraries. Credentials stay on the host: the agent sees mount aliases, item refs, metadata and files downloaded into its scratch directory — never tokens or drive ids.

### Mounts

A mount is an alias for one (plugin, account, drive). Configure them in `config/config.yml` — or let the CLI do it:

```bash
familiar storage list                 # configured mounts + drives you could mount (queries providers)
familiar storage add ms365 me@company.com --drive sites/Verwaltung/Dokumente --as verwaltung
familiar storage lint --online        # logins, drives, write roots; --fix creates missing write roots
familiar storage remove verwaltung
```

```yaml
storage:
  allowWrite: false          # master switch for every mutation
  mounts:
    verwaltung:
      plugin: ms365
      account: me@company.com
      drive: sites/Verwaltung/Dokumente   # omitted = the account's own OneDrive
      access: read                        # read (default) | readwrite
      writeRoots: ["/Familiar"]           # default; where readwrite mounts may change things
      searchByDefault: true
```

`add` and `remove` edit the file in place and keep your comments. Restart the daemon after changing mounts or `allowWrite`.

### Policy defaults

- Nothing is writable unless `storage.allowWrite: true` **and** the mount has `access: readwrite`; even then only below its `writeRoots` (default `/Familiar`). The write tools stay visible to the agent and fail with a `PolicyDenied` message it is told to relay to you.
- `storage_delete` moves items to the provider's trash (never a permanent delete) and needs your approval per call.
- Moves need both source and destination inside the write roots; copies only check the destination.
- Each agent run may move at most `storage.runQuotaMb` (default 200) MB.
- File contents are never interpreted on the host: the agent downloads files and converts them itself.

### Refs

Items are addressed as `mount:/folder/file.ext` (path form) or `mount#<id>` (id form, stable across renames). Every tool result starts with a `[…]` header line carrying provenance and the `next_cursor` for paging.
