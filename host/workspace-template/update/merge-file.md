---
tools: workspace, fs_read, fs_write, fs_grep
skills: workspace-update
---

# Merge one workspace file with its new template

The prompt names one pending file (`path: …`). Decide it following the preloaded skill `workspace-update`:

1. `workspace_update_diff` for the path.
2. If needed, read related files (`fs_read`) — e.g. what the user's change refers to.
3. Either settle it (`fs_write` the merged content to the workspace path, then `workspace_update_resolve` with `accept_live`, or `use_template` / `accept_live` directly), or — only when the user's intent is genuinely unclear — leave it pending.

Reply with exactly one line:
- settled: `decided: <path> — <use_template|accept_live> — <one-line reason> (commit <id>)`
- left open: `question: <path> — <the question for the user> — recommended: <your recommendation>`
