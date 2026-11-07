---
tools: workspace, fs_read, fs_write, fs_grep, fs_glob
skills: workspace-update
---

# Apply one workspace update note

The prompt names one update note (`id: …`). Get its text from `workspace_update_status` (`pendingNotes`), then carry out its instructions across the workspace following the preloaded skill `workspace-update`. Find affected files with `fs_grep` / `fs_glob`; that includes files the user created themselves.

When done, call `workspace_update_note_done` with a one-line summary (also when the note turned out not to apply here — say so). If a step needs the user's decision, do everything else, do **not** mark the note done, and say what is open.

Reply with exactly one line:
- done: `decided: note <id> — <what you changed> (commit <id>)`
- open: `question: note <id> — <the question for the user> — recommended: <your recommendation>`
