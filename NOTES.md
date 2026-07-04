Features:

* Knowledge über das Step Limit einbauen: Der System Prompt muss die Anzahl noch verfügbarer Steps enthalten. Aktuell bricht er häufiger bei 15 Steps ab, weil er es nicht weiß. Aktuelles Limit in den System Prompt, und eine injizierte User Message 3 Steps vor dem Limit.
* Fail events that broke the step limit, currently they are "Done"

* File Storages like Onedrive, Dropbox, Google Drive, ... - read & write access, search. Done like calendar + mail, a default set of tools for all providers and provider-specific implementations in plugins.
* Host-side LLM chat with access to console tools for selections, prompts etc. as a service - used for setup and plugin CLI tools.
* Diff Tool for the workspace vs default workspace
* Git repo for the workspace files?
* Sane setup process

* NEW MEMORY? The wiki approach seems to mangle stuff up - maybe give Hindsight a shot?

Neues CLI Tool: `logs`
* `logs tail` tails the current data/logs/ log file but pretty prints the JSON objects in it.


## Refactoring

### Now

* **No more environment variables for container config**: Currently, every config option passed to the container is written as a docker environment variable. Instead, hand over a JSON or string.
* **MCP functions: keep or remove the renaming of "-"?**
* 

### For production deployments:

* cli.sh replacen mit `npx familiar`, die prechecks über den npm hook prepublishOnly laufen lassen. Gleichheit zwischen dev und prod sicherstellen.

## For later

- MS365: Enable / Disable Out of Office Notes
- Protect the bastion port on the host? Maybe a simple basic auth?
- Spotify MCP based on https://github.com/aome510/spotify-player
- Alternativen Modellprovider testen: Synthetic.new - wie Featherless, 30€ / Monat, scheinbar zuverlässiger

- Plugin-specific config linters as extension point. Special Cases:
  - ms365.calendar.refreshCron: check if it's a valid cron expression. If not, thats a problem because the delta will never be updated and the calendar will never be refreshed / keep the same from/to dates forever.

### Browser Automatisation

- Browser Automatisierungen sind ein komplexes Feld. Läuft wie folgt: 
  * Wir integrieren einen roll-your-own Chromium Docker Container (am wahrscheinlichsten linuxserver/chromium) und legen die debugging ports raus (--remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --no-sandbox).
  * Wir integrieren `Stagehand` als Library in einem Plugin. Es integriert sich optimal mit unserem Vercel AI SDK Universum. Das Plugin bietet dann:
    * Aufzeichnen von Workflows auf dem Host per CLI über eine komfortablen Chat - "Gehe dort hin", "Gehe hier hin", vielleicht sogar mit gepipeten Screenshots.
    * Speichern von Credentials unterwegs: Username, Passwort, 2FA Seeds (wie speichern wir die sicher?)
    * Am Ende hat man einen Workflow, im idealfall self-healing, den wir unter einem namen abspeichern, bspw. "get-amazon-shopping-list". Der kann vom Agent im Container per Tool `browser_run_workflow` mit dem Namen aufgerufen werden, die Credentials werden automatisch eingespeist, und der Workflow läuft im externen Chromium Docker Container.
    * Der Agent liefert dann in Markdown die Ergebnisse zurück.

## Workspace Linter

- No unexpected .md files in the root
- Check reserved group names in toolgroups/: "all", "none", "system", mcp group ids
- Check the tools in the tool groups for existence
- Parse the tools frontmatter statements and check if they are valid (existing tools and groups and parseable)
- Parse all cron expressions to check if valid
- Count tools per handler and warn if there are too many
- Check token count of the aggregated system prompt and warn if too high

Extreme:
- Check handler files freeform content for tool name mentions that do not exist
- Check models if they exist

plugins:
- Check if chat/compaction/index.md exists and is parseable
- Check if skills/memory/save.md exists and is parseable


## Before release

- The whole schema contains migrations at the moment, pull a blank slate

## Security Holes

## Setup process

- check:
  - node
  - npm
  - docker
  - npm i
  - npm run build --workspaces --if-present (attention: does not resolve the order of dependencies, trying to build telegram before whisper etc. - AST based dependency resolution would be nice)
  - Use node-linux or node-mac packages to create a native service

Important: many services need a restart after login (whatsapp, o365, ...). Request that?

## Marketing Speak

* Ralph Loop for loosing context vs what we do with different handler files
* Interesting: [statewright](https://github.com/statewright/statewright) implements narrowed down scopes for agents in certain steps, quite similar to our handler files. "State machine guardrails that control which tools your AI agent can use in each phase. Define a workflow once, enforce it across Claude Code, Codex, Cursor, opencode, and Pi." && "Instead of making the model bigger, make the problem smaller."
* Observable!
* Provider-independent
* Local. Independent. Markdown?
* Independent. Dependable. Markdown?