---
name: workspace-update
description: How to bring workspace files up to date with new templates of familiar and its plugins without losing the user's customizations, and how to apply update notes.
tools: workspace
---

# Updating the workspace to new templates

Familiar and its plugins ship default workspace files (handlers, skills, `PROMPT.md`, `ARCHITECTURE.md`, …). When a new version changes them, the daemon compares three states per file: the template version the file was last synced to (the *base*), the new template, and the workspace file. Files the user never touched are updated automatically. What is left needs judgment and shows up in `workspace_update_status`:

| `kind` | Meaning |
|---|---|
| `both-changed` | The template and the workspace file both changed since the last sync. |
| `unknown-base` | No earlier sync is known (first run, or the user created a file at a path a template now ships) and the file differs from the template. Only `liveToTemplate` is available: you can't tell which side a difference comes from, so judge by content. |
| `live-deleted` | The user deleted the file, the template changed it since. |
| `template-deleted` | The template dropped the file, the user had changed it. |

`workspace_update_diff` shows `templateChanges` (what familiar changed), `localChanges` (what the user changed), `liveToTemplate` and a `mergeProposal` (3-way merge; with `hasConflicts` it holds `<<<<<<< workspace` / `=======` / `>>>>>>> new template` blocks).

## Deciding a file

The guiding rule: **keep what the user meant, take what is new.** Template changes usually bring new capabilities (a new placeholder, a new tool, a fixed instruction); the user's changes express their preferences (tone, language, rules about people, extra steps).

- **Clean merge proposal** (`hasConflicts: false`): read it once for sense — two edits can merge cleanly and still contradict each other. If it reads right, `fs_write` it to the workspace path (`livePath`), then `workspace_update_resolve` with `accept_live`.
- **Conflicts:** write your own merged version that keeps both intents and contains no conflict markers, then `accept_live`. Example: the template reworded a step the user also reworded — keep the user's wording and add the new information the template brought.
- **The template change is irrelevant or superseded** by the user's version (e.g. typo fixes in text the user rewrote): `accept_live`.
- **The user's change was only a workaround** that the new template now solves properly: `use_template`.
- **`unknown-base`:** take the template's new sections and keep the user's personal content. When the file is clearly the user's own (no resemblance to the template), `accept_live`.
- **`live-deleted`:** the user removed the file on purpose — normally `accept_live` (stays deleted). Only restore it with `use_template` when the template change is something the user clearly needs (say so in the report).
- **`template-deleted`:** familiar no longer uses the file. If the user's changes still matter, keep it (`accept_live`) and mention it; otherwise `use_template` removes it.

You may decide on your own, also on conflicts, when you are confident: every `workspace_update_resolve` is its own commit in the workspace git history and can be undone. Ask the user only when you cannot tell what they meant — e.g. the template removes a passage the user deliberately added, or a change would alter how the assistant treats people or acts on their behalf. Then leave the file pending and raise the question.

Never touch `SOUL.md` content the user wrote; merge only clearly structural template additions there.

## Applying update notes

An update note (`pendingNotes`) describes a change that a file diff cannot show: a renamed placeholder, a moved file, a new convention that also affects files the user created. Follow its instructions across the whole workspace (`fs_grep` / `fs_glob` find affected files), then call `workspace_update_note_done` with a one-line summary. That commits your edits. If the note does not apply to this workspace, still mark it done and say so in the summary.

## Talking to the user about it

When a banner mentions open workspace update decisions, or the user asks about them: call `workspace_update_status`, explain each open item in plain words (what familiar changed, what the user had changed, your recommendation), let the user decide, then resolve it as above. The report of the last update run is in `files/updates/` (newest file). When nothing is open any more, remove the banner(s) about it with `banner_remove`.

To show what an update changed, the workspace is a git repository: `git -c safe.directory=/workspace -C /workspace log --oneline` and `… show <commit>` (bash tool, read-only — never commit, reset or check out yourself; the host owns the history).
