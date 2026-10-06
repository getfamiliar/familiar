# Writing prompts

This is the reference for shaping how the assistant thinks and behaves. Everything that ends up in front of the model is plain markdown in your workspace (`data/workspace/`, mounted as `/workspace` in the agent container). There is no prompt text hidden in code: if you want to know what the model sees, read the files described here, or ask the CLI to render it for you.

## The big picture

Every time something happens in your world (a mail arrives, a cron fires, you write in the chat), Familiar creates an **event** with a **topic** such as `mail:ms365` or `chat:telegram`. The agent then runs a **handler** for that topic: a markdown file that tells the model what to do. The prompt the model receives is assembled from three kinds of files:

| File | What it is | Who writes it |
| --- | --- | --- |
| `PROMPT.md` | The **prompt template**: the frame every handler is rendered into. Decides which parts appear, in which order, with which wording. | You (a default is shipped) |
| `<topic>/<handler>.md` | A **handler**: the task-specific instructions plus YAML frontmatter (model, tools, …). | You, plugins (shipped defaults), the agent itself on request |
| Anything else in the workspace | **Includes** (e.g. `SOUL.md`, `CONTEXT.md`), **skills** (`skills/<id>/SKILL.md`), knowledge files (`people/…`, `wiki/…`). | You and the agent |

The template pulls in the handler and other files through **placeholders** like `{HANDLER_CONTENT}` and `{SOUL.md}`. The final prompt therefore is: `PROMPT.md` with every placeholder replaced.

## The prompt template: `PROMPT.md`

`PROMPT.md` lives in the workspace root. The daemon copies the shipped version there on start whenever the file is missing; after that it is yours to edit — later updates never overwrite it. The shipped version looks like this (abridged):

```markdown
# Identity

{SOUL.md}

# Context

{CONTEXT.md}

# Handler

{HANDLER_CONTENT}

{PRELOADED_SKILLS}

# Available skills

The following skills are available in the `skills/` folder. Read one with …

{SKILL_LIST}

# Available tools

{TOOL_LIST}

These are preloaded for convenience — not the limit of what you can do. …

## The bash tool

… write access to `/scratch` and these workspace paths: {WRITABLE_PATH_LIST}.
… The following packages are installed: {PYTHON_PACKAGE_LIST}. …

{CACHE_MARKER}

# Runtime

{RUNTIME_LIST}

# Files staged for this event

…

{STAGED_FILE_LIST}
```

Headings, wording and order are all up to you. Remove a section you don't want, rephrase one that the model misreads, add your own.

### Placeholder syntax

There are two kinds of tokens:

- **`{NAME}`** — a placeholder whose value is computed per handler or per run. Names are upper case: `[A-Z][A-Z0-9_]*`.
- **`{path.md}`** — an **include**: the content of a workspace file, e.g. `{SOUL.md}` or `{prompts/tone.md}`. The path is relative to the workspace root and may not contain `..` or start with `/`.

Any other braces are left alone, so JSON examples (`{"to": "anna"}`) and lowercase words in braces are safe to use.

Rules worth knowing:

- **Workspace markdown is template, everything else is data.** Placeholders are expanded in `PROMPT.md`, in files it includes, and in the handler body (`{HANDLER_CONTENT}`), recursively up to three levels deep. So a handler can itself say `{skills/jira-issue/SKILL.md}` or `{TOOL_LIST}`. Values that come from code or plugins (tool lists, memories, mail payloads, …) are inserted literally and never scanned again — a mail containing `{SOUL.md}` cannot pull your files into the prompt.
- **Mistakes don't break runs.** An unknown placeholder stays in the prompt verbatim, a missing include renders as empty, a cyclic or too-deep include keeps its token. Each case logs a `prompt template: …` warning on the agentrun, and `familiar prompt dry-run` lists them.
- **No conditionals.** A template can't say "only if". Lists that are empty render as `(none)`. If one group of handlers needs a different frame, give them a different template (see `systemPrompt` below).
- **Size caps.** Each included file and the handler body are cut at 8,000 characters, the whole system prompt at 32,000, each marked with `…[truncated, original N chars]`.

### The cache marker

`{CACHE_MARKER}` splits the template in two:

- **Before the marker → system prompt.** It should be identical for every run of the same handler.
- **After the marker → the start of the current user message**, right before the event's own prompt and payload.

Why: model providers cache prompts by **prefix**. The longest unchanged beginning of a request is served from cache, which is faster and cheaper; the first changed character ends the cached part. DeepSeek and OpenAI do this automatically, Anthropic with explicit breakpoints. If the current time appeared near the top of the system prompt, every run would start with a cache miss — in a chat, the whole conversation history behind it would be re-processed on every turn.

So: put stable things (identity, handler, skill list) **before** the marker and anything that changes per run (time, topic, staged files) **after** it. Each placeholder below is marked `static` or `dynamic`; a `dynamic` one placed before the marker triggers a warning. Without a marker, the whole template becomes the system prompt.

## Placeholder reference

Run `familiar prompt placeholders` for the authoritative list including placeholders added by your installed plugins.

| Placeholder | Kind | Value |
| --- | --- | --- |
| `{CACHE_MARKER}` | static | Not a value: the split point between system prompt and user message (see above). Only the first one in `PROMPT.md` counts. |
| `{HANDLER_CONTENT}` | static | The body of the resolved handler (merged with its parent handlers, see "Inheritance"). Placeholders inside it are expanded. |
| `{PRELOADED_SKILLS}` | static | The full content of every skill listed in the handler's `skills` frontmatter (frontmatter stripped), each under its own `# Skill \`id\` (preloaded)` heading with a note that it is already loaded. Empty when the handler preloads nothing. Not cut at the per-file size limit. Placeholders inside are expanded. |
| `{HANDLER_PATH}` | static | Workspace-relative path of the handler, e.g. `chat/telegram/index.md`. |
| `{HANDLER_INHERITS}` | static | The parent handlers it was merged with, as `` `chat/index.md` ``, or `(none)`. |
| `{SKILL_LIST}` | static | One bullet per skill in `skills/`: `` - `id`: description ``. |
| `{TOOL_LIST}` | static¹ | One bullet per tool preloaded for this run. |
| `{PYTHON_PACKAGE_LIST}` | static | Comma-separated python packages available to the `bash` tool (`python.packages` in `config.yml`). |
| `{WRITABLE_PATH_LIST}` | static | Comma-separated `core.writablePaths` globs a non-privileged run may write to. |
| `{RUNTIME_LIST}` | dynamic | Bullets: current time, event topic, handler file, inheritance, `outputChat`, `privileged`. |
| `{CURRENT_TIME}` | dynamic | e.g. `Tuesday, 2026-05-19T18:43:12 in timezone Europe/Berlin`. |
| `{EVENT_TOPIC}` | dynamic | The event topic, e.g. `chat:telegram`. |
| `{PRIVILEGED}` | dynamic | `yes` if the run stems from you (terminal, your Telegram), else `no`. Non-privileged runs can't write outside `/scratch` and the writable paths. |
| `{STAGED_FILE_LIST}` | dynamic | Bullets of files staged in `/scratch/<event-id>/` (e.g. mail attachments) with their sizes. |
| `{some/file.md}` | static | Content of that workspace file. |

¹ `{TOOL_LIST}` contains the handler's `tools` **plus** tools this handler used often in recent runs. That second part drifts over time, so the system prompt isn't perfectly stable while `{TOOL_LIST}` sits before the marker. Move it after the marker if caching matters to you more than having the tools near the handler text.

Plugins can add their own placeholders (always `dynamic`); they show up in `familiar prompt placeholders` with the plugin's id as source. Plugins can also **append** text to the user message without a placeholder — the memory plugin does this with its `# Memories` table of relevant notes. Appended text always comes after the template's post-marker part.

## What the model receives

For one run, the model gets:

1. **System prompt** — the template up to `{CACHE_MARKER}`.
2. **History** — in a chat: the previous messages of the conversation. For a subagent: the prompts and results of its parent runs.
3. **User message**, consisting of:
   - the template after `{CACHE_MARKER}`,
   - plugin-appended sections (e.g. memories),
   - the event's or caller's prompt text,
   - the event payload as a `# Payload` JSON block (if any).
4. **Tool definitions** — the preloaded tools plus `tool_list`, `tool_describe` and `tool_call`, through which every other tool is reachable.

## Handlers

A handler is a markdown file at `<topic folder>/<name>.md`. The topic `chat:telegram` maps to the folder `chat/telegram/`. When an event arrives, its root run uses the handler `index` (unless the event names another start handler); handlers start other handlers by name via the `start_subagent` / `schedule_subagent` tools.

```markdown
---
model: fast
tools: core, mail_*
temperature: 0.3
---

Triage the incoming mail. Before replying, read `people/<sender>.md` if it exists.
```

Keep handlers short. Tell the agent *where to find* context (`people/…`, `wiki/…`, a skill) instead of pasting it in — it reads files on demand with `fs_read`.

Files directly in the workspace root (`PROMPT.md`, `SOUL.md`, …) are never handlers, and neither is anything under `skills/` or under `core.writablePaths`.

### Resolution and inheritance

Handlers are resolved from the most specific folder upwards. For topic `chat:telegram:group` and handler `index`, Familiar looks at:

1. `chat/telegram/group/index.md`
2. `chat/telegram/index.md`
3. `chat/index.md`

By default **every** existing file in that chain is merged, root first: the bodies are concatenated (general guidance first, specific last) and frontmatter fields declared deeper override the ones above. Set `mergeMode: replace` in a file to cut the chain above it — that file then stands alone (with whatever is below it). `{HANDLER_INHERITS}` and the runtime list show which files were merged.

### Frontmatter reference

All fields are optional. Unknown fields are ignored (so `description:` for your own documentation is fine), but a known field with the wrong type makes the handler fail to load with an error naming the file and field.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `model` | string | `inference.defaultModel` | Model to run under: an alias from `inference.aliases` in `config.yml` (e.g. `fast`, `smart`) or a provider model id. Use a light model for routing and triage, a heavy one for drafting and reasoning. |
| `temperature` | number | provider default | Sampling temperature. `0` for deterministic extraction tasks, higher for creative writing. |
| `tools` | list or comma string | `core` | Tools preloaded into the run. Entries are tool names (`send_chat`), globs (`mail_*`, quote them in a YAML list: `"mail_*"`), or groups: `core`, `fs`, `bash`, `reflection`, `mcp`, `all`, `none`, plus one group per MCP id and per plugin id. Entries are combined. Tools not listed stay reachable through `tool_call`; preloading just saves the model a discovery step. |
| `skills` | list or comma string | — | Skill ids (folder names under `skills/`) whose `SKILL.md` is rendered straight into the prompt via `{PRELOADED_SKILLS}`, e.g. `skills: jira, reflection`. The `tools` a preloaded skill declares are added to this handler's preloaded tools. A missing skill fails the run with an error naming it. Like every field, a deeper handler's `skills` replaces its parent's. |
| `maxOutputTokens` | positive integer | from model metadata | Cap on tokens the model may produce per step. Never exceeds what the model supports. Useful against runaway monologues. |
| `maxRetries` | integer ≥ 0 | `inference.maxRetries` (10) | Retries on temporary provider errors (429, 5xx, timeouts) with exponential backoff. `0` disables retries for this handler. |
| `outputChat` | boolean | `false` | Also post the run's final text answer into the chat. For models that answer in text instead of calling `send_chat`. Don't combine with a handler that calls `send_chat`, or you'll get every answer twice. |
| `cron` | string | — | Run this handler on a schedule. Friendly syntax (`every monday at 8 am`, `every 5 minutes`, `weekly`) or a raw cron expression. Picked up live when you save the file; check with `familiar cron list`. |
| `mergeMode` | `merge` \| `replace` | `merge` | How this file combines with the handlers above it (see "Resolution and inheritance"). |
| `systemPrompt` | `default` \| `none` \| path | `default` | Which template to render: `default` = `PROMPT.md`; `none` = only the handler body, no template at all (no identity, no tool list, no runtime facts) — for narrowly defined tasks where framing would only distract; a path like `prompts/minimal.md` = your own template for this handler. |
| `toolCallOffloadingLimit` | positive integer | `core.toolCallOffloadingLimit` (16,000) | Token size above which a tool result is written to a scratch file instead of being shown inline (the model gets the path and can read it in parts). Raise it for handlers that need large results inline, lower it for noisy ones. |

## Skills

When several handlers need the same know-how ("how we create Jira issues"), put it in a skill: `skills/<id>/SKILL.md`, with a `description` in its frontmatter.

```markdown
---
description: How to create a Jira issue (default project, due-date conventions, parent linking).
---

# How to create a Jira issue
…
```

Skills with a `description` appear in `{SKILL_LIST}`, and the shipped template tells the model to `fs_read` a skill when it fits. Models don't always do that, so a handler can also **preload** skills with `skills: jira-issue, reflection` in its frontmatter: their content lands in `{PRELOADED_SKILLS}`, marked as already loaded. Preloading costs prompt space on every run; leaving it to the model costs only when needed. (A plain instruction like "Before creating a Jira issue, read `skills/jira-issue/SKILL.md`" works too.)

A skill may declare the tools it is about in its own frontmatter:

```markdown
---
description: The Tesla tools — what each one does and when to reach for it.
tools: tesla
---
```

`tools` uses the same entries as a handler's `tools` (names, globs, groups). It only matters when the skill is preloaded: those entries are then added to the handler's preloaded tools (on top of `core` if the handler declares no `tools` of its own).

Skills are never run as handlers or subagents and grant no permissions — preloading tools only saves the model a discovery step, since every tool is reachable via `tool_call` anyway and privilege checks happen per call.

## Recipes

**A leaner frame for one group of handlers.** Create `prompts/minimal.md`:

```markdown
{SOUL.md}

{HANDLER_CONTENT}

{CACHE_MARKER}

Now: {CURRENT_TIME}
```

and set `systemPrompt: prompts/minimal.md` in those handlers.

**Shared rules for all mail handlers.** Write them once to `mail/rules.md`, and include `{mail/rules.md}` in each mail handler — or put them in `mail/index.md` and let inheritance carry them to `mail/ms365/index.md`.

**Adding personal context.** Put facts about you in `CONTEXT.md` (job, family, preferences) — it's included by the default template. For larger knowledge, keep files under `people/` or `wiki/` and tell handlers to read them on demand.

## Checking your work

| Command | What it shows |
| --- | --- |
| `familiar prompt placeholders` | Every placeholder, its source (core or plugin), whether it's static or dynamic, and what it contains. Works without a running daemon. |
| `familiar prompt dry-run <topic> [--handler <name>] [--privileged] [--prompt "<text>"] [--full]` | Renders the prompt for a handler exactly as a run would — with the real tool set and plugin values — without starting a run or calling a model. Shows the template used, every placeholder with its value and where it ends up, plugin-appended sections and all warnings. `--full` prints the complete system prompt and user message head. `--prompt` feeds a sample message to plugins (e.g. so memory search has something to search for). Needs the daemon running. |
| `familiar cron list` | Every handler with a `cron:` field and how its schedule was parsed. |
| `familiar tools list` | All available tools — useful for writing `tools:`. |
| `familiar events report <id> -v` | What happened in a past event, including the prompt each run actually received — when `core.logSystemPrompt` is enabled in `config.yml` (`"full"`, or `"non-static"` to replace includes by `<content of file …>` and keep the log small). |

Example:

```bash
familiar prompt dry-run chat:telegram --privileged --prompt "What's on my calendar tomorrow?" --full
```

## Tips

- **Iterate with `dry-run`.** Change a file, re-render, compare. No need to trigger a real event.
- **Watch the warnings.** A typo like `{SKIL_LIST}` stays in the prompt verbatim and is reported — the model would see the raw token otherwise.
- **Short handlers, pointers to knowledge.** The model reads files on demand; preloading everything makes every run slower and the important parts easier to overlook.
- **Stable before the marker, volatile after it.** Keeps runs fast and cheap with providers that cache.
- **Let the assistant edit its own handlers.** In a privileged chat you can ask it to change a handler ("from now on, file invoices under …") — it's the same markdown you'd edit by hand.
