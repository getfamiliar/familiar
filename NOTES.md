NEXT:

* Freigabefunktionen
* tool_call in der Reflection unwrappen?

* Whatsapp Single Mode

* Mail: Lass ihn alle ausgehenden Mails verarbeiten und im Original speichern, mit limit.

* Additional pypi packages for the agent container: how to do that?

* Calendar und Mails: nicht leere Ergebnisliste zurückgeben, wenn kein Mailbox / Calendar Provider registriert ist, sondern eine passende Fehlermeldung für den Agent.

* Neue Kalender Tools: list all calendars mit sync status und "resync" tool, das einfach die Delta-Dateien löscht und damit den Kalender zu einer neusynchronisation zwingt.

Features:

* Host-side LLM chat with access to console tools for selections, prompts etc. as a service - used for setup and plugin CLI tools.
* Sane setup process

Neues CLI Tool: `logs`
* `logs tail` tails the current data/logs/ log file but pretty prints the JSON objects in it.

## Refactoring

## For later

- Additional storage providers: Google Drive, Dropbox, ...
- Additional calendar providers: Google Calendar, ...
- MS365: Enable / Disable Out of Office Notes
- Alternativen Modellprovider testen: Synthetic.new - wie Featherless, 30€ / Monat, scheinbar zuverlässiger
- User-based extra PIP packages need a new method - the baked-in packages from the image cannot / should not be directly extended by endusers as this requires a full checkout of the project source to be able to build. Seems overkill, we need a better feature here that allows adding PIP packages with a short-timed online agent container.

- Plugin-specific config linters as extension point. Special Cases:
  - ms365.calendar.refreshCron: check if it's a valid cron expression. If not, thats a problem because the delta will never be updated and the calendar will never be refreshed / keep the same from/to dates forever.

- Telegram Group Events: require a MTProto Client (gramJS) and a separate login, the current bot mode cannot do that. A lot of work for no use currently.

### Later features with external deps

* Firecrawl for web crawling and browsing automation (see firecrawl.dev)
* VOICE ASSISTANT:
  - Use Picovoice.ai components:
    - Porcupine for local wakeword detection
    - Eagle for speaker recognition
- Spotify MCP based on https://github.com/aome510/spotify-player

### Browser Automatisation

- Browser Automatisierungen sind ein komplexes Feld. Läuft wie folgt: 
  * Wir integrieren einen roll-your-own Chromium Docker Container (am wahrscheinlichsten linuxserver/chromium) und legen die debugging ports raus (--remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --no-sandbox).
  * Wir integrieren `Stagehand` als Library in einem Plugin. Es integriert sich optimal mit unserem Vercel AI SDK Universum. Das Plugin bietet dann:
    * Aufzeichnen von Workflows auf dem Host per CLI über eine komfortablen Chat - "Gehe dort hin", "Gehe hier hin", vielleicht sogar mit gepipeten Screenshots.
    * Speichern von Credentials unterwegs: Username, Passwort, 2FA Seeds (wie speichern wir die sicher?)
    * Am Ende hat man einen Workflow, im idealfall self-healing, den wir unter einem namen abspeichern, bspw. "get-amazon-shopping-list". Der kann vom Agent im Container per Tool `browser_run_workflow` mit dem Namen aufgerufen werden, die Credentials werden automatisch eingespeist, und der Workflow läuft im externen Chromium Docker Container.
    * Der Agent liefert dann in Markdown die Ergebnisse zurück.
- Recording über das Webinterface, Steuerung per Chat, Streaming von Screenshots aus dem Container.

## Workspace Linter

- No unexpected .md files in the root
- Parse the tools frontmatter statements and check if they are valid (existing tools)
- Parse all cron expressions to check if valid
- Check token count of the aggregated system prompt and warn if too high
- Check if both x.md and x/index.md are present and warn
- Check model aliases on existence

Extreme:
- Check handler files freeform content for tool name mentions that do not exist
- Check models if they exist

plugins:
- Check for events that are emitted but not processed.

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
  - Use node-linux or node-mac packages to create a native service!

- Define default model aliases (fast, default, smart, vision) and add them to the config.yml.

Important: many services need a restart after login (whatsapp, o365, ...). Request that?

## Marketing Speak

* Ralph Loop for loosing context vs what we do with different handler files
* Interesting: [statewright](https://github.com/statewright/statewright) implements narrowed down scopes for agents in certain steps, quite similar to our handler files. "State machine guardrails that control which tools your AI agent can use in each phase. Define a workflow once, enforce it across Claude Code, Codex, Cursor, opencode, and Pi." && "Instead of making the model bigger, make the problem smaller."
* Observable!
* Provider-independent
* Local. Independent. Markdown?
* Independent. Dependable. Markdown?
