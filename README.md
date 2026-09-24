# Familiar

**Your personal AI assistant. Loyal. Local. Markdown.**

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
