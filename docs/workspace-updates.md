# Workspace Updates

Familiar and its plugins ship default workspace files: handlers, skills, `PROMPT.md`, `ARCHITECTURE.md`, `SOUL.md`. The user (and the assistant) then edit these files in `workspace/`. When a new version of familiar or a plugin changes a template, overwriting the workspace file would destroy those edits, and never updating it leaves the workspace behind. This page describes how both are avoided, and how template authors (core and plugins) write **update notes** for changes a file diff can't express.

## How it works

On every daemon start, `WorkspaceUpdater` (`host/src/workspace/`) compares three versions of each template file:

- the **base**: the template version the workspace file was last synced to (`data/workspace-base/files/<path>`),
- the **template**: the current version shipped by core (`host/workspace-template/`) or a plugin (`workspaceTemplate`),
- the **workspace file** (`workspace/<path>`, or its twin handler form `x/index.md` ↔ `x.md`).

| Situation | What happens |
| --- | --- |
| Template unchanged since the base | Nothing. |
| Workspace file untouched (equals the base) | Replaced by the new template (fast-forward). |
| Workspace file already equals the new template | Base advances. |
| New template file, no workspace file | Copied in (seeded). |
| Template dropped the file, workspace file untouched | Removed. |
| Template and workspace file both changed | Pending: an `update:merge-file` agent run decides. |
| No base known and the file differs (first run, or the user created a file at that path) | Pending (`unknown-base`). |
| User deleted the file, template changed it | Pending (`live-deleted`). |
| Template dropped the file, user changed it | Pending (`template-deleted`). |

When two sources ship the same path, the earlier one wins: core first, then plugins in load order. Files of a plugin that is no longer installed are left alone. A file's base only advances when the file is settled, so an open decision keeps its original base across later versions.

**History.** The workspace is a git repository (created on the first start, via isomorphic-git, no system `git` needed). The host commits a snapshot before syncing, one commit with the automatic changes, and one commit per decision of the update agent. Undo any of them with git. Only the host writes the repository. When `workspace/.stfolder` exists (Syncthing), `.git` is added to `.stignore` first: every machine keeps its own history. If git fails, the updater still seeds new files but overwrites and removes nothing.

**Telling the user.** Automatic overwrites and removals produce a banner written by the host. For what is left open, the host's `WorkspaceMergeCoordinator` starts one exact, privileged agent run per item, in the background after the daemon is up: first one `update:apply-note` event per new update note (handler `update/apply-note.md`), then one `update:merge-file` event per pending file (handler `update/merge-file.md`). It waits for each, so they run one after another, each with a full tool budget and no limit on the number of items. Each run answers with one line (`decided: …` or `question: …`); afterwards the host checks what is still pending, writes the report `files/updates/<date>.md` (commits it) and creates the banners: one summarizing what was updated, one when decisions need the user. Each event's idempotency key fingerprints its item (path, situation, workspace content), so an item an earlier start already handed over — e.g. one the agent left as a question — is not run again until the file changes; such items are only listed under "Still open from an earlier update" when there is something new to report. On daemon shutdown the coordinator stops before the next item; the rest follows on the next start. The policy for merging lives in the workspace skill `skills/workspace-update/SKILL.md`; the chat agent uses it to discuss open items with the user.

**Tools** (group `workspace`): `workspace_update_status` and `workspace_update_diff` (read-only), `workspace_update_resolve` and `workspace_update_note_done` (privileged). **CLI:** `familiar workspace status`, `familiar workspace diff <path>`, `familiar workspace resolve <path> use_template|accept_live [--summary …]`. They work without the daemon.

**Machines that share a workspace.** The base lives per machine in `data/workspace-base/` and is not synced. When a second familiar gets its workspace synced in from another one (Syncthing), set `core.autoUpdate: false` there, otherwise it would re-decide every customized file the first machine already settled and both would write the same files. With the switch off the daemon skips the whole sync (no seeding, no updates, no git commits), and the writing tools refuse with an `AutoUpdateDisabled` error.

To start over (every file then counts as never synced and differing files become `unknown-base`), stop the daemon and delete `data/workspace-base/`.

## Writing template changes

You don't need to do anything special for ordinary template edits: change the file in `host/workspace-template/` or your plugin's `workspace-template/`, and the updater takes it from there. Keep in mind:

- **Users customize these files.** Small, focused edits merge cleanly; reformatting a whole file (rewrapping, reordering sections) turns every customized copy into a conflict the agent has to untangle.
- **Renaming or moving a file** looks like "old file dropped, new file added": untouched copies move cleanly, customized copies end up with a `template-deleted` decision plus a seeded new file that lacks the customization. Write an update note that tells the agent to carry the customization over.
- **Changes that affect files you don't ship** — a renamed placeholder, a removed tool, a new frontmatter convention — never show up in a template diff. Write an update note.

## Update notes

An update note is a markdown file with instructions the update agent carries out **once** on each live workspace, like a database migration for markdown. Use one when a template diff alone would leave existing workspaces broken or inconsistent.

### Where they live

- Core: `host/workspace-updates/<YYYY-MM-DD>-<slug>.md`.
- Plugins: a `workspace-updates/` folder in the plugin package, declared in the manifest and listed in `package.json` `files`:

```ts
export default definePlugin({
    id: "demo",
    workspaceTemplate: path.join(import.meta.dirname, "..", "workspace-template"),
    workspaceUpdates: path.join(import.meta.dirname, "..", "workspace-updates"),
    host: { … },
});
```

```json
"files": ["build", "workspace-template", "workspace-updates"]
```

### Naming and identity

- The file name is `YYYY-MM-DD-<slug>.md` (date of the change, lowercase slug). Notes run in name order per source, so the date prefix keeps them in sequence.
- The note id is `<source>/<file name without .md>`, e.g. `core/2026-11-07-banner-section` or `demo/2026-12-01-rename-reply-skill`. Familiar records done notes by id in `data/workspace-base/state.json`. **Never rename or reuse a published note's file name**: a renamed note runs again, a reused name never runs.
- Don't edit a published note to change what it does; add a new one. Fixing a typo is fine.
- Delete notes only when no supported version can still be upgraded from before them.

A fresh install (no `data/workspace-base/state.json` yet) marks every existing note as done without running it: the new workspace is seeded from the current templates, so historic migrations don't apply.

### What to write

The note is read by the model, in the user's workspace, possibly months after the change, alongside the user's own files. Write it for that reader:

1. **What changed and why**, in one or two sentences.
2. **How to find affected files**, concretely: a search string or glob (`fs_grep` for `{BANNERS}`, every `*.md` under `chat/`), and which ones the template already handles (those are merged separately; the note is for everything else).
3. **What to do with each**, including the edge cases: user wording to keep, files that already have the new form, files that should be left alone.
4. **When the note doesn't apply** (the user never used the feature), say that it can simply be marked done.

Don't include code to execute, credentials or anything user-specific. Keep it short; the agent has the `workspace-update` skill for the general rules (merge carefully, keep the user's intent, ask when unsure).

Example — `host/workspace-updates/2026-11-07-banner-placeholder.md`:

```markdown
# Placeholder `{BANNERS}` renamed to `{BANNER_LIST}`

The prompt placeholder that lists active banners is now called `{BANNER_LIST}`. `{BANNERS}` is no longer replaced and would show up verbatim in prompts.

1. Search the whole workspace for `{BANNERS}` (`fs_grep`). `PROMPT.md` comes from the template and is merged separately; skip it if it is still pending.
2. Replace every `{BANNERS}` with `{BANNER_LIST}`. Leave the surrounding text as it is.
3. If nothing contains `{BANNERS}`, the user never used it: mark the note done.
```

### Testing a note

1. Put the note in place and restart the daemon in a dev home (`npm run dev -- start`).
2. `familiar workspace status` lists it under pending notes; the next start hands it to an `update:apply-note` run.
3. Check the result with `git -C workspace log -p` and the report in `workspace/files/updates/`.
